import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("agent", Path(__file__).with_name("agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qwen-agent-test-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "example.txt"
        self.events = []
        self.patches = [patch.object(agent, "emit", lambda kind, **data: self.events.append({"type": kind, **data})),
                        patch.object(agent.Path, "home", return_value=Path(self.temp.name))]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def call(self, name, **args):
        return agent.execute({"id": "test-call", "function": {"name": name, "arguments": json.dumps(args)}})

    def test_read_is_numbered_and_bounded(self):
        self.path.write_text("one\ntwo\nthree\n")
        result = self.call("read_file", path=str(self.path), offset=2, limit=1)
        self.assertIn("2: two", result)
        self.assertNotIn("1: one", result)
        self.assertEqual(self.events[-1]["status"], "done")

    def test_knowledge_search_uses_private_index(self):
        indexed = {"results": [{"path": "/notes/project.md"}]}
        with patch.object(agent.knowledge_base, "search", return_value=indexed) as search:
            result = json.loads(self.call("search_knowledge", query="project plan"))
        search.assert_called_once_with("project plan")
        self.assertEqual(result["results"][0]["path"], "/notes/project.md")

    def test_read_rejects_special_and_binary_files(self):
        self.assertIn("regular file", self.call("read_file", path="/dev/zero"))
        self.path.write_bytes(b"a\0b")
        self.assertIn("Binary file", self.call("read_file", path=str(self.path)))

    def test_create_waits_for_exact_approval_and_rejection_does_not_write(self):
        def reject(*args):
            self.assertFalse(self.path.exists())
            self.assertIn("+hello", args[-1])
            return False
        with patch.object(agent, "approve", side_effect=reject):
            self.assertIn("Rejected", self.call("write_file", path=str(self.path), content="hello\n"))
        self.assertFalse(self.path.exists())

    def test_edit_preserves_mode_and_backups_original(self):
        self.path.write_text("before\n")
        self.path.chmod(0o640)
        with patch.object(agent, "approve", return_value=True):
            result = self.call("edit_file", path=str(self.path), old_text="before", new_text="after")
        self.assertEqual(self.path.read_text(), "after\n")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o640)
        self.assertIn("Original saved", result)
        backups = list(Path(self.temp.name).glob(".local/state/local-qwen/backups/*/original"))
        self.assertEqual(backups[0].read_text(), "before\n")

    def test_changed_file_requires_a_new_proposal(self):
        self.path.write_text("before")
        def approve(*args):
            self.path.write_text("user changed it")
            return True
        with patch.object(agent, "approve", side_effect=approve):
            self.assertIn("changed while awaiting", self.call("edit_file", path=str(self.path), old_text="before", new_text="after"))
        self.assertEqual(self.path.read_text(), "user changed it")

    def test_new_file_cannot_overwrite_existing_file(self):
        self.path.write_text("keep")
        with patch.object(agent, "approve") as approval:
            self.assertIn("already exists", self.call("write_file", path=str(self.path), content="overwrite"))
            approval.assert_not_called()
        self.assertEqual(self.path.read_text(), "keep")

    def test_nonunique_edit_is_rejected(self):
        self.path.write_text("word word")
        with patch.object(agent, "approve") as approval:
            self.assertIn("exactly once", self.call("edit_file", path=str(self.path), old_text="word", new_text="x"))
            approval.assert_not_called()

    def test_command_rejection_never_launches_process(self):
        with patch.object(agent, "approve", return_value=False), patch.object(agent, "run_process") as run:
            result = self.call("run_command", cwd=self.temp.name, command="touch should-not-exist")
            run.assert_not_called()
            self.assertIn("Rejected", result)

    def test_approved_command_uses_working_directory(self):
        with patch.object(agent, "approve", return_value=True):
            result = self.call("run_command", cwd=self.temp.name, command="printf hello > example.txt; pwd")
        self.assertEqual(self.path.read_text(), "hello")
        self.assertIn(self.temp.name, result)
        self.assertIn("Exit code: 0", result)

    def test_timeout_kills_descendants(self):
        result = agent.run_process(["bash", "-c", "sleep 0.3; touch example.txt"], self.temp.name, timeout=0.05)
        self.assertIn("Stopped after", result)
        import time
        time.sleep(0.4)
        self.assertFalse(self.path.exists())

    def test_approval_eof_and_wrong_id_fail_closed(self):
        data = '{"type":"decision","id":"wrong","approved":true}\n'
        with patch.object(agent.sys, "stdin", io.StringIO(data)):
            self.assertFalse(agent.approve("expected", "write_file", "create file", "+content"))

    def test_streamed_tool_arguments_are_reassembled(self):
        chunks = [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "one", "function": {"name": "read_file", "arguments": '{"path":'}}]}}]},
                  {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"/etc/os-release"}'}}]}, "finish_reason": "tool_calls"}]}]
        stream = io.BytesIO(b"".join(b"data: " + json.dumps(c).encode() + b"\n\n" for c in chunks) + b"data: [DONE]\n\n")
        with patch.object(agent, "trim_context"), patch.object(agent, "api", return_value=stream):
            result = agent.completion([], agent.TOOLS)
        call = result["tool_calls"][0]
        self.assertEqual(call["id"], "one")
        self.assertEqual(json.loads(call["function"]["arguments"]), {"path": "/etc/os-release"})

    def test_context_trimming_preserves_current_tool_group(self):
        messages = [{"role": "system", "content": "system"}, {"role": "user", "content": "old"},
                    {"role": "assistant", "tool_calls": []}, {"role": "tool", "content": "old result"},
                    {"role": "user", "content": "new"}, {"role": "assistant", "tool_calls": []},
                    {"role": "tool", "content": "new result"}]
        with patch.object(agent, "api", side_effect=[{"prompt": "large"}, {"tokens": [0] * 7100}, {"prompt": "small"}, {"tokens": [0] * 100}]):
            agent.trim_context(messages, agent.TOOLS)
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "tool"])
        self.assertEqual(messages[1]["content"], "new")

    def test_rejection_stops_the_turn_without_retry_or_queued_actions(self):
        calls = [{"id": str(i), "function": {"name": "run_command", "arguments": "{}"}} for i in range(2)]
        reply = {"role": "assistant", "content": "", "tool_calls": calls}
        request = json.dumps({"messages": [{"role": "user", "content": "test"}]}) + "\n"
        with patch.object(agent.sys, "stdin", io.StringIO(request)), patch.object(agent, "completion", return_value=reply) as completion, patch.object(agent, "execute", return_value="Rejected by user. No command was executed.") as execute:
            self.assertEqual(agent.main(), 0)
        completion.assert_called_once()
        execute.assert_called_once()
        history = [e for e in self.events if e["type"] == "history"][-1]["messages"]
        self.assertEqual([m["tool_call_id"] for m in history if m["role"] == "tool"], ["0", "1"])
        self.assertEqual(self.events[-1]["type"], "done")


if __name__ == "__main__":
    unittest.main()

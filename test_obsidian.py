import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agent
import obsidian_memory as memory


class ObsidianTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qwen-vault-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "Vault with spaces"
        (self.root / "Inbox").mkdir(parents=True)
        self.config = {"enabled": True, "vault": str(self.root), "inbox": "Inbox", "memory": "Inbox/Memory.md"}
        self.config_path = Path(self.temp.name) / "obsidian.json"
        self.config_path.write_text(json.dumps(self.config))
        self.events = []
        for item in [patch.object(memory, "CONFIG", self.config_path),
                     patch.object(agent, "emit", lambda kind, **data: self.events.append({"type": kind, **data})),
                     patch.object(agent.Path, "home", return_value=Path(self.temp.name))]:
            item.start()
            self.addCleanup(item.stop)

    def call(self, name, **args):
        return agent.execute({"id": "note-test", "function": {"name": name, "arguments": json.dumps(args)}})

    def test_search_ranks_notes_and_returns_openable_links(self):
        (self.root / "Python Testing.md").write_text("# Tests\nUse pytest fixtures.\n")
        (self.root / "Other.md").write_text("Python has libraries.")
        result = json.loads(self.call("search_notes", query="python testing"))
        self.assertEqual(result["results"][0]["note"], "Python Testing.md")
        self.assertTrue(result["results"][0]["url"].startswith("obsidian://open?path="))
        self.assertIn("Vault+with+spaces", result["results"][0]["url"])

    def test_search_excludes_hidden_and_linked_private_files(self):
        (self.root / ".obsidian").mkdir()
        (self.root / ".obsidian/hidden.md").write_text("secret")
        outside = Path(self.temp.name) / "private.md"
        outside.write_text("secret")
        (self.root / "linked.md").symlink_to(outside)
        result = json.loads(self.call("search_notes", query="secret"))
        self.assertEqual(result["results"], [])

    def test_new_note_uses_approval_and_cannot_overwrite(self):
        with patch.object(agent, "approve", return_value=True) as approval:
            result = self.call("save_note", title="Plan", content="- Build the sidebar")
            approval.assert_called_once()
        path = self.root / "Inbox/Plan.md"
        self.assertIn("Saved", result)
        self.assertIn('title: "Plan"', path.read_text())
        with patch.object(agent, "approve") as approval:
            self.assertIn("already exists", self.call("save_note", title="Plan", content="overwrite"))
            approval.assert_not_called()

    def test_rejected_note_and_fact_never_write(self):
        with patch.object(agent, "approve", return_value=False):
            self.assertIn("Rejected", self.call("save_note", title="Rejected", content="No"))
            self.assertIn("Rejected", self.call("remember_fact", fact="Prefer examples"))
        self.assertEqual(list((self.root / "Inbox").iterdir()), [])

    def test_saved_fact_is_reloaded_and_deduplicated(self):
        with patch.object(agent, "approve", return_value=True):
            self.assertIn("Saved", self.call("remember_fact", fact="I prefer short examples."))
        self.assertIn("I prefer short examples.", memory.context())
        with patch.object(agent, "approve") as approval:
            self.assertIn("already saved", self.call("remember_fact", fact="I prefer short examples."))
            approval.assert_not_called()
        path = self.root / "Inbox/Memory.md"
        path.write_text(path.read_text().replace("short examples", "detailed examples"))
        self.assertIn("detailed examples", memory.context())
        self.assertNotIn("short examples", memory.context())

    def test_full_memory_requires_consolidation(self):
        path = self.root / "Inbox/Memory.md"
        path.write_text("x" * memory.MEMORY_LIMIT)
        with patch.object(agent, "approve") as approval:
            self.assertIn("full", self.call("remember_fact", fact="new"))
            approval.assert_not_called()

    def test_title_and_inbox_cannot_escape_vault(self):
        self.assertIn("plain note title", self.call("save_note", title="../../escape", content="no"))
        self.config["inbox"] = "../elsewhere"
        self.config_path.write_text(json.dumps(self.config))
        self.assertIn("inside", self.call("save_note", title="escape", content="no"))

    def test_missing_mount_and_disabled_connection(self):
        self.config["vault"] = str(self.root / "missing")
        self.config_path.write_text(json.dumps(self.config))
        self.assertIn("unavailable", memory.context())
        self.config["enabled"] = False
        self.config_path.write_text(json.dumps(self.config))
        self.assertEqual(memory.context(), "")
        self.assertIn("not connected", self.call("search_notes", query="anything"))


if __name__ == "__main__":
    unittest.main()

import contextlib
import base64
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import codex_agent


class CodexBridgeTests(unittest.TestCase):
    def test_account_changes_and_refresh_tokens_do_not_mix_identity(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CODEX_HOME': directory}), patch.object(codex_agent, 'executable', return_value='/bin/codex'), patch('subprocess.run', return_value=SimpleNamespace(returncode=0)):
            path = Path(directory) / 'auth.json'
            path.write_text(json.dumps({'auth_mode':'chatgpt', 'tokens':{'account_id':'account-one', 'refresh_token':'first-secret'}}))
            first = codex_agent.account_status()
            self.assertTrue(first['signed_in'])
            self.assertNotIn('account-one', json.dumps(first))
            self.assertNotIn('first-secret', json.dumps(first))
            path.write_text(json.dumps({'auth_mode':'chatgpt', 'tokens':{'account_id':'account-one', 'refresh_token':'new-secret'}}))
            self.assertEqual(codex_agent.account_status()['account_id'], first['account_id'])
            path.write_text(json.dumps({'auth_mode':'chatgpt', 'tokens':{'account_id':'account-two'}}))
            self.assertNotEqual(codex_agent.account_status()['account_id'], first['account_id'])

    def test_logout_and_unavailable_cli_clear_account_and_models(self):
        with patch.object(codex_agent, 'executable', return_value='/bin/codex'), patch('subprocess.run', return_value=SimpleNamespace(returncode=1)):
            status = codex_agent.account_status()
            self.assertFalse(status['signed_in'])
            self.assertEqual(status['account_id'], '')
            self.assertEqual(status['models'], [])
        with patch.object(codex_agent, 'executable', return_value=None):
            self.assertFalse(codex_agent.account_status()['installed'])

    def test_login_launches_terminal_without_shell_and_logout_uses_cli(self):
        with patch.dict(os.environ, {'DISPLAY': ':1'}), patch.object(codex_agent, 'executable', return_value='/tmp/codex with spaces'), patch('shutil.which', return_value='/usr/bin/terminal'), patch('subprocess.Popen') as launch:
            codex_agent.login()
            self.assertEqual(launch.call_args.args[0], ['/usr/bin/terminal','/tmp/codex with spaces','login'])
            self.assertNotIn('shell', launch.call_args.kwargs)
        with patch.object(codex_agent, 'executable', return_value='/bin/codex'), patch('subprocess.run', return_value=SimpleNamespace(returncode=0)) as run, patch.object(codex_agent, 'account_status', return_value={'signed_in':False}):
            self.assertFalse(codex_agent.logout()['signed_in'])
            self.assertEqual(run.call_args.args[0], ['/bin/codex','logout'])

    def test_model_and_image_are_cli_arguments(self):
        args = codex_agent.command('/bin/codex', '/tmp/root', '/tmp/out', 'test-model', ['/tmp/screen shot.png'])
        self.assertEqual(args[args.index('--model') + 1], 'test-model')
        self.assertEqual(args[args.index('--image') + 1], '/tmp/screen shot.png')

    def test_authorized_full_access_bypasses_codex_sandbox(self):
        args = codex_agent.command('/bin/codex', '/tmp/root', '/tmp/out', full_access=True)
        self.assertEqual(args[args.index('--sandbox') + 1], 'danger-full-access')
        self.assertIn('approval_policy="never"', args)

    def test_reasoning_override_is_bounded_and_preserves_sandbox(self):
        args = codex_agent.command('/bin/codex', '/tmp/root', '/tmp/out', 'test-model', effort='high')
        self.assertIn('model_reasoning_effort="high"', args)
        self.assertIn('approval_policy="never"', args)
        self.assertEqual(args[args.index('--sandbox') + 1], 'workspace-write')
        with self.assertRaises(ValueError):
            codex_agent.command('/bin/codex', '/tmp/root', '/tmp/out', effort='ultra')

    def test_reasoning_levels_follow_selected_model_and_default_profile(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CODEX_HOME': directory}):
            home = Path(directory)
            home.joinpath('config.toml').write_text('model="m1"\nprofile="coding"\n[profiles.coding]\nmodel="m2"\n')
            home.joinpath('models_cache.json').write_text(json.dumps({'models':[
                {'slug':'m1', 'supported_reasoning_levels':[{'effort':'medium'},{'effort':'ultra'}]},
                {'slug':'m2', 'supported_reasoning_levels':[{'effort':'high'}]},
            ]}))
            self.assertEqual(codex_agent.reasoning_levels('m1'), ['medium'])
            self.assertEqual(codex_agent.reasoning_levels(''), ['high'])
            self.assertEqual(codex_agent.reasoning_levels('unknown'), [])

    def test_jev_profile_reaches_codex_and_failures_or_disabled_toggle_keep_defaults(self):
        for enabled, fail, confidence in [(True, False, .95), (True, False, .5), (True, True, .95), (False, False, .95)]:
            with self.subTest(enabled=enabled, fail=fail), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                binary = root / 'fake-codex'
                binary.write_text('#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\n'
                                  'Path("capture.json").write_text(json.dumps({"args":sys.argv,"prompt":sys.stdin.read()}))\n'
                                  'print(json.dumps({"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Complete."}}))\n'
                                  'print(json.dumps({"type":"turn.completed"}))\n')
                binary.chmod(0o700)
                data = {'review_root':directory, 'messages':[{'role':'user','content':'Review classes without editing.'}], 'jev_enabled':enabled}
                output = io.StringIO()
                def live_run(binary, root, prompt, model, images, effort, emit, skills, jev_data=None, full_access=False):
                    root.joinpath('capture.json').write_text(json.dumps({'args':['model_reasoning_effort="' + effort + '"'], 'prompt':prompt}))
                    self.assertIsNotNone(jev_data)
                    emit({'type':'done'})
                with patch('codex_live.run', side_effect=live_run), patch.object(codex_agent, 'executable', return_value=str(binary)), patch.object(codex_agent, 'reasoning_levels', return_value=['high']), patch.object(codex_agent.jev_helper, 'select_profile', return_value={'effort':'high','effort_confidence':confidence,'focus':'oop','focus_confidence':confidence}, side_effect=ValueError('OpenRouter credits are exhausted') if fail else None) as select, patch('sys.stdin', io.StringIO(json.dumps(data))), contextlib.redirect_stdout(output):
                    codex_agent.main()
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                capture = json.loads(root.joinpath('capture.json').read_text())
                self.assertEqual(events[-1]['type'], 'done')
                self.assertEqual(select.call_count, int(enabled))
                self.assertEqual('model_reasoning_effort="high"' in capture['args'], enabled and not fail and confidence >= .85)
                self.assertEqual('object invariants' in capture['prompt'], enabled and not fail and confidence >= .85)
                self.assertIn('For review/explanation requests do not edit', capture['prompt'])
                if enabled:
                    self.assertEqual(events[0]['status'], 'running')
                    self.assertEqual(events[1]['status'], 'error' if fail else 'done')

    def test_invalid_image_payloads_are_rejected(self):
        for images in [None, [{}], [{'mime':'image/png','data':base64.b64encode(b'not png').decode()}], [{}]*5]:
            with self.assertRaises(ValueError):
                codex_agent.validate_images(images)

    def test_project_sandbox_and_stdin_prompt(self):
        args = codex_agent.command('/bin/codex', '/tmp/project with spaces', '/tmp/out')
        self.assertEqual(args[args.index('--cd') + 1], '/tmp/project with spaces')
        self.assertEqual(args[args.index('--sandbox') + 1], 'workspace-write')
        self.assertEqual(args[-1], '-')
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', args)

    def test_command_failures_are_visible(self):
        result = codex_agent.translate({'type': 'item.completed', 'item': {
            'id': 'i', 'type': 'command_execution', 'command': 'pytest',
            'exit_code': 1, 'aggregated_output': 'test failed'}})
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['output'], 'test failed')
        self.assertIsNone(codex_agent.translate({'type': 'item.completed', 'item': {
            'id': 'r', 'type': 'reasoning', 'text': 'internal'}}))

    def test_real_subprocess_stream_is_translated_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'fake-codex'
            binary.write_text('#!/usr/bin/env python3\nimport json,sys\n'
                              'from pathlib import Path\n'
                              'assert sys.argv[sys.argv.index("--model")+1] == "test-model"\n'
                              'assert Path(sys.argv[sys.argv.index("--image")+1]).read_bytes().startswith(b"\\x89PNG")\n'
                              'request=sys.stdin.read()\n'
                              'assert "Selected file: example.py" in request\n'
                              'print(json.dumps({"type":"item.completed","item":'
                              '{"id":"m","type":"agent_message","text":"Reviewed."}}))\n'
                              'print(json.dumps({"type":"turn.completed"}))\n')
            binary.chmod(0o700)
            source = io.StringIO(json.dumps({'review_root': directory, 'selected_file': 'example.py',
                                            'messages': [{'role': 'user', 'content': 'review'}], 'codex_model':'test-model',
                                            'images':[{'mime':'image/png','data':base64.b64encode(b'\x89PNG\r\n\x1a\nimage-fixture').decode()}]}) + '\n')
            output = io.StringIO()
            with patch.object(codex_agent, 'executable', return_value=str(binary)), patch('sys.stdin', source), contextlib.redirect_stdout(output):
                codex_agent.main()
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(events[0]['type'], 'text')
            self.assertTrue(events[0]['block'])
            self.assertEqual(events[-1]['type'], 'done')


if __name__ == '__main__':
    unittest.main()

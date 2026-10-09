import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import codex_live


FAKE_SERVER = '''#!/usr/bin/env python3
import json, sys, time
from pathlib import Path
def send(message):
    print(json.dumps(message), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if method == 'initialize':
        send({'id': message['id'], 'result': {}})
    elif method == 'thread/start':
        assert message['params']['sandbox'] == 'workspace-write'
        assert message['params']['approvalPolicy'] == 'never'
        assert message['params']['ephemeral'] is True
        send({'id': message['id'], 'result': {'thread': {'id': 'thread-test'}}})
    elif method == 'turn/start':
        Path('turn-input.json').write_text(json.dumps(message['params']))
        send({'id': message['id'], 'result': {'turn': {'id': 'turn-test'}}})
        def event(method, params):
            send({'method': method, 'params': params})
        event('item/agentMessage/delta', {'itemId': 'message-test', 'delta': 'Writing the function.'})
        event('item/completed', {'item': {'type': 'agentMessage', 'id': 'message-test', 'text': 'Writing the function.'}})
        for diff in ['+export function add(a, b) {\\n', '+export function add(a, b) {\\n+  return a + b;\\n+}\\n']:
            event('item/fileChange/patchUpdated', {'itemId': 'patch-test', 'changes': [{'path': str(Path.cwd() / 'added.js'), 'kind': {'type': 'add'}, 'diff': diff}]})
            time.sleep(.8)
        Path('added.js').write_text('export function add(a, b) {\\n  return a + b;\\n}\\n')
        event('item/completed', {'item': {'type': 'fileChange', 'id': 'patch-test', 'status': 'completed', 'changes': [{'path': str(Path.cwd() / 'added.js'), 'kind': {'type': 'add'}, 'diff': '+export function add(a, b) {\\n+  return a + b;\\n+}\\n'}]}})
        time.sleep(.8)
        event('turn/completed', {'turn': {'id': 'turn-test', 'status': 'completed'}})
'''


APPROVAL_SERVER = '''#!/usr/bin/env python3
import json, sys
from pathlib import Path
def send(value):
    print(json.dumps(value), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method == 'initialize':
        send({'id':request['id'], 'result':{}})
    elif method == 'thread/start':
        assert request['params']['sandbox'] == 'read-only'
        assert request['params']['approvalPolicy'] == 'on-request'
        send({'id':request['id'], 'result':{'thread':{'id':'thread'}}})
    elif method == 'turn/start':
        item = {'id':'edit', 'type':'fileChange', 'changes':[{'path':'app.js', 'kind':{'type':'add'}, 'diff':'+export const value = 1;'}]}
        send({'method':'item/started', 'params':{'item':item}})
        send({'id':100, 'method':'item/fileChange/requestApproval', 'params':{'itemId':'edit'}})
    elif request.get('id') == 100:
        decision = request['result']['decision']
        Path('decision.txt').write_text(decision)
        if decision == 'accept':
            Path('app.js').write_text('export const value = 1;')
        item = {'id':'edit', 'type':'fileChange', 'status':'completed' if decision == 'accept' else 'declined', 'changes':[{'path':'app.js', 'kind':{'type':'add'}, 'diff':'+export const value = 1;'}]}
        send({'method':'item/completed', 'params':{'item':item}})
        send({'method':'item/completed', 'params':{'item':{'id':'answer', 'type':'agentMessage', 'text':'The edit is complete and tests pass.'}}})
        send({'method':'turn/completed', 'params':{'turn':{'status':'completed'}}})
'''


class CodexLiveTests(unittest.TestCase):
    def test_scope_checks_happen_before_writes_and_fail_closed(self):
        cases = [({'action':'allow', 'action_confidence':.96}, True),
                 ({'action':'allow', 'action_confidence':.5}, False),
                 ({'action':'deny', 'action_confidence':.99}, False),
                 (ValueError('offline'), False)]
        for result, allowed in cases:
            with self.subTest(result=result), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                binary = root / 'fake-codex'
                binary.write_text(APPROVAL_SERVER)
                binary.chmod(0o700)
                events = []
                def check(data, action):
                    self.assertFalse(root.joinpath('app.js').exists())
                    self.assertFalse(root.joinpath('decision.txt').exists())
                    self.assertEqual(action['changes'][0]['path'], 'app.js')
                    if isinstance(result, Exception):
                        raise result
                    return result
                def evaluate(data, answer, evidence):
                    self.assertTrue(root.joinpath('decision.txt').exists())
                    self.assertEqual(evidence[0]['status'], 'done' if allowed else 'error')
                    self.assertIn('tests pass', answer)
                    return {'completion':'unsupported', 'completion_confidence':.99}
                with patch.object(codex_live.jev_helper, 'check_action', side_effect=check), patch.object(codex_live.jev_helper, 'check_completion', side_effect=evaluate):
                    codex_live.run(str(binary), root, 'Add the value.', '', [], '', events.append, jev_data={'messages':[{'role':'user', 'content':'Add the value.'}]})
                self.assertEqual(root.joinpath('app.js').exists(), allowed)
                self.assertEqual(root.joinpath('decision.txt').read_text(), 'accept' if allowed else 'decline')
                self.assertTrue(any(e['type'] == 'notice' for e in events))
                self.assertEqual(events[-1], {'type':'done'})

    def test_project_boundaries_and_persistent_grants_are_declined_before_jev(self):
        cases = [('outside', "{'itemId':'edit'}", "'../outside.js'"),
                 ('session grant', "{'itemId':'edit', 'grantRoot':str(Path.cwd())}", "'app.js'"),
                 ('symlink', "{'itemId':'edit'}", "'linked/outside.js'")]
        for name, params, path in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
                root = Path(directory)
                root.joinpath('linked').symlink_to(outside, target_is_directory=True)
                binary = root / 'fake-codex'
                fixture = APPROVAL_SERVER.replace("'path':'app.js'", "'path':" + path).replace("'params':{'itemId':'edit'}", "'params':" + params)
                binary.write_text(fixture)
                binary.chmod(0o700)
                with patch.object(codex_live.jev_helper, 'check_action') as decide, patch.object(codex_live.jev_helper, 'check_completion', return_value={'completion':'supported', 'completion_confidence':.95}):
                    codex_live.run(str(binary), root, 'Add the value.', '', [], '', lambda event:None, jev_data={'messages':[]})
                decide.assert_not_called()
                self.assertEqual(root.joinpath('decision.txt').read_text(), 'decline')
                self.assertFalse(root.joinpath('app.js').exists())

    def test_command_approvals_are_individual_and_interactive_grants_are_declined(self):
        cases = [({}, True), ({'kind':'stdin'}, False),
                 ({'cwd':'/outside'}, False), ({'additionalPermissions':{'network':True}}, False),
                 ({'availableDecisions':['acceptForSession','decline']}, False)]
        for extra, allowed in cases:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                binary = root / 'fake-codex'
                params = {'itemId':'edit', 'cwd':str(root), 'command':'node --check app.js', **extra}
                fixture = APPROVAL_SERVER.replace('item/fileChange/requestApproval', 'item/commandExecution/requestApproval').replace("'params':{'itemId':'edit'}", "'params':" + repr(params))
                binary.write_text(fixture)
                binary.chmod(0o700)
                with patch.object(codex_live.jev_helper, 'check_action', return_value={'action':'allow','action_confidence':.95}) as decide, patch.object(codex_live.jev_helper, 'check_completion', return_value={'completion':'supported','completion_confidence':.95}):
                    codex_live.run(str(binary), root, 'Check app.js.', '', [], '', lambda event:None, jev_data={'messages':[]})
                self.assertEqual(root.joinpath('decision.txt').read_text(), 'accept' if allowed else 'decline')
                if allowed:
                    self.assertEqual(decide.call_args.args[1]['command'], 'node --check app.js')
                elif 'availableDecisions' not in extra:
                    decide.assert_not_called()

    def test_patch_paths_stay_inside_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            event = codex_live.patch_event({'itemId': 'test', 'changes': [
                {'path': str(root / 'app.js'), 'kind': {'type': 'update'}, 'diff': '+safe'},
                {'path': '../outside.js', 'diff': '+outside'},
            ]}, root)
            self.assertEqual(event['changes'], [{'path': 'app.js', 'kind': 'update', 'diff': '+safe'}])

    def test_real_subprocess_streams_patch_snapshots_before_disk_write_and_done(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'fake-codex'
            binary.write_text(FAKE_SERVER)
            binary.chmod(0o700)
            events = []
            def capture(event):
                events.append(event)
                if event['type'] == 'patch' and event['status'] == 'writing':
                    self.assertFalse(root.joinpath('added.js').exists())
            skill = {'name': 'fixture-skill', 'path': str(root / 'SKILL.md')}
            codex_live.run(str(binary), root, 'Add a function.', '', [], '', capture, [skill])
            inputs = json.loads(root.joinpath('turn-input.json').read_text())['input']
            self.assertIn({'type': 'skill', **skill}, inputs)
            patches = [event for event in events if event['type'] == 'patch']
            self.assertEqual([patch['status'] for patch in patches], ['writing', 'writing', 'applied'])
            self.assertNotIn('return', patches[0]['changes'][0]['diff'])
            self.assertIn('return', patches[1]['changes'][0]['diff'])
            self.assertEqual(len([event for event in events if event['type'] == 'text']), 1)
            self.assertEqual(events[-1], {'type': 'done'})
            self.assertIn('return a + b', root.joinpath('added.js').read_text())

    def test_authorized_full_access_uses_native_unrestricted_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'fake-codex'
            binary.write_text(FAKE_SERVER.replace("'workspace-write'", "'danger-full-access'").replace('time.sleep(.8)', 'time.sleep(.01)'))
            binary.chmod(0o700)
            events = []
            codex_live.run(str(binary), root, 'Add a function.', '', [], '', events.append, full_access=True)
            self.assertEqual(events[-1], {'type':'done'})
            self.assertTrue(root.joinpath('added.js').exists())

    def test_protocol_error_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'fake-codex'
            binary.write_text('#!/usr/bin/env python3\nimport json,sys\n'
                              'sys.stdin.readline()\nprint(json.dumps({"id":1,"error":{"message":"Not signed in"}}),flush=True)\n')
            binary.chmod(0o700)
            with self.assertRaisesRegex(ValueError, 'Not signed in'):
                codex_live.run(str(binary), Path(directory), 'Test.', '', [], '', lambda event: None)


if __name__ == '__main__':
    unittest.main()

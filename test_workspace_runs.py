import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

import workspace


class WorkspaceRunTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        (self.root / 'agent.py').write_text('''import json, pathlib, sys, time
payload = json.loads(sys.stdin.readline())
root = pathlib.Path(payload['review_root'])
print(json.dumps({'type': 'text', 'text': 'Writing.'}), flush=True)
while not (root / 'continue').exists():
    time.sleep(.01)
(root / 'result.py').write_text('value = 42\\n')
print(json.dumps({'type': 'done'}), flush=True)
''')
        self.server = workspace.ThreadingHTTPServer(('127.0.0.1', 0), workspace.Handler)
        self.port = self.server.server_port
        self.patches = [patch.object(workspace, 'PORT', self.port), patch.object(workspace, 'BASE', self.root),
                        patch.object(workspace, 'LOGS', self.root / 'logs')]
        for item in self.patches:
            item.start()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.run_id = uuid.uuid4().hex

    def tearDown(self):
        with workspace.RUN_LOCK:
            process = workspace.RUNS.get(self.run_id)
        if process:
            workspace.stop_process(process)
        record = workspace.RUN_RECORDS.get(self.run_id)
        if record:
            with record['condition']:
                record['condition'].wait_for(lambda: record['finished'], timeout=5)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        for item in reversed(self.patches):
            item.stop()
        workspace.RUN_RECORDS.pop(self.run_id, None)
        self.folder.cleanup()

    def post(self, route, data, token=workspace.TOKEN):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        connection.request('POST', '/api/' + route, json.dumps({'root': str(self.root), **data}),
                           {'X-Workspace-Token': token, 'Content-Type': 'application/json'})
        return connection, connection.getresponse()

    def start(self):
        connection, response = self.post('chat', {'request_id': self.run_id, 'messages': [{'role': 'user', 'content': 'Write code'}]})
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.readline()), {'type': 'run', 'id': self.run_id})
        self.assertEqual(json.loads(response.readline())['text'], 'Writing.')
        response.close()
        connection.close()

    def test_disconnect_reconnect_replays_same_run_and_completes(self):
        self.start()
        connection, response = self.post('run', {'id': self.run_id})
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.readline())['id'], self.run_id)
        self.assertEqual(json.loads(response.readline())['text'], 'Writing.')
        (self.root / 'continue').touch()
        events = [json.loads(line) for line in response.read().splitlines()]
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual((self.root / 'result.py').read_text(), 'value = 42\n')
        connection.close()
        # A refresh after completion also recovers the full answer.
        connection, response = self.post('run', {'id': self.run_id})
        self.assertEqual([json.loads(line)['type'] for line in response.read().splitlines()], ['run', 'text', 'done'])
        connection.close()
        self.assertFalse(workspace.INFERENCE_LOCK.locked())

    def test_completed_run_recovers_from_disk_after_memory_is_lost(self):
        self.start()
        (self.root / 'continue').touch()
        connection, response = self.post('run', {'id':self.run_id})
        original = [json.loads(line) for line in response.read().splitlines()]
        connection.close()
        workspace.RUN_RECORDS.pop(self.run_id)
        connection, response = self.post('run', {'id':self.run_id})
        self.assertEqual(response.status, 200)
        self.assertEqual([json.loads(line) for line in response.read().splitlines()], original)
        connection.close()
        file = workspace.state_directory() / 'runs' / (self.run_id + '.jsonl')
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_interrupted_run_recovers_partial_work_without_claiming_completion(self):
        self.start()
        saved = workspace.recover_run(self.run_id)
        self.assertEqual(saved['events'][1]['text'], 'Writing.')
        self.assertEqual(saved['events'][-1]['type'], 'error')
        self.assertTrue(saved['events'][-1]['interrupted'])
        self.assertTrue(saved['finished'])
        self.assertNotIn('done', [event['type'] for event in saved['events']])

    def test_sessions_are_backed_up_and_scoped_to_project_and_account(self):
        saved = {'active':'session-1', 'sessions':[{'id':'session-1','messages':[{'role':'user','content':'Keep my task.'}]}]}
        connection, response = self.post('sessions/save', {'saved':saved})
        self.assertEqual(response.status, 200)
        response.read(); connection.close()
        connection, response = self.post('sessions/load', {})
        self.assertEqual(json.loads(response.read())['saved'], saved)
        connection.close()
        connection, response = self.post('sessions/load', {'root':'/tmp'})
        self.assertIsNone(json.loads(response.read())['saved'])
        connection.close()
        with patch.object(workspace.codex_agent, 'account_status', return_value={'signed_in':True,'account_id':'current'}):
            connection, response = self.post('sessions/load', {'provider':'codex','account_id':'other'})
            self.assertEqual(response.status, 403)
            response.read(); connection.close()

    def test_browser_and_desktop_backups_merge_without_erasing_newer_sessions(self):
        for saved in [
            {'active':'browser','updatedAt':20,'sessions':[{'id':'browser','updatedAt':20,'messages':[{'role':'user','content':'Newer browser task'}]}]},
            {'active':'desktop','updatedAt':30,'sessions':[{'id':'desktop','updatedAt':30,'messages':[{'role':'user','content':'Desktop task'}]}]},
            {'active':'browser','updatedAt':10,'sessions':[{'id':'browser','updatedAt':10,'messages':[{'role':'user','content':'Stale browser task'}]}]},
        ]:
            connection, response = self.post('sessions/save', {'saved':saved})
            self.assertEqual(response.status, 200)
            response.read(); connection.close()
        connection, response = self.post('sessions/load', {})
        sessions = {session['id']:session for session in json.loads(response.read())['saved']['sessions']}
        connection.close()
        self.assertEqual(set(sessions), {'browser','desktop'})
        self.assertEqual(sessions['browser']['messages'][0]['content'], 'Newer browser task')

    def test_stop_still_works_after_disconnect(self):
        self.start()
        connection, response = self.post('stop', {'id': self.run_id})
        self.assertTrue(json.loads(response.read())['stopped'])
        connection.close()
        connection, response = self.post('run', {'id': self.run_id})
        events = [json.loads(line) for line in response.read().splitlines()]
        self.assertEqual(events[-1]['type'], 'error')
        self.assertFalse((self.root / 'result.py').exists())
        connection.close()

    def test_reconnect_is_bound_to_workspace_and_account(self):
        self.start()
        for data, token, status in [({'id': self.run_id}, 'wrong', 403),
                                    ({'id': self.run_id, 'root': '/tmp'}, workspace.TOKEN, 404),
                                    ({'id': 'missing'}, workspace.TOKEN, 404)]:
            connection, response = self.post('run', data, token)
            self.assertEqual(response.status, status)
            response.read(); connection.close()
        record = workspace.RUN_RECORDS[self.run_id]
        record['account_id'] = 'original'
        with patch.object(workspace.codex_agent, 'account_status', return_value={'signed_in': True, 'account_id': 'changed'}):
            connection, response = self.post('run', {'id': self.run_id, 'account_id': 'original'})
            self.assertEqual(response.status, 403)
            response.read(); connection.close()


if __name__ == '__main__':
    unittest.main()

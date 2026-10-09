import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import workspace


class WorkspaceFeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = workspace.ThreadingHTTPServer(('127.0.0.1', 0), workspace.Handler)
        cls.port = cls.server.server_port
        cls.port_patch = patch.object(workspace, 'PORT', cls.port)
        cls.port_patch.start()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.port_patch.stop()

    def request(self, path, data=None, token=workspace.TOKEN):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        headers = {'X-Workspace-Token': token, 'Content-Type': 'application/json'}
        conn.request('POST' if data is not None else 'GET', path, json.dumps(data) if data is not None else None, headers)
        response = conn.getresponse()
        status, result = response.status, json.loads(response.read())
        conn.close()
        return status, result

    def test_editor_read_save_and_stale_write_through_http(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'example.py'
            file.write_text('value = 1\n')
            data = {'root': root, 'path': 'example.py'}
            code, read = self.request('/api/editor/read', data)
            self.assertEqual(code, 200)
            save = {**data, 'version':read['version'], 'content':'value = 2\n'}
            self.assertEqual(self.request('/api/editor/save', save)[0], 200)
            self.assertEqual(file.read_text(), save['content'])
            self.assertEqual(self.request('/api/editor/save', {**save,'content':'value = 3\n'})[0], 400)
            self.assertEqual(file.read_text(), 'value = 2\n')
            self.assertEqual(self.request('/api/editor/save', save, token='wrong')[0], 403)

    def test_edits_and_logout_are_blocked_during_a_run(self):
        with tempfile.TemporaryDirectory() as root:
            with workspace.INFERENCE_LOCK:
                self.assertEqual(self.request('/api/codex/logout', {})[0], 409)
                self.assertEqual(self.request('/api/editor/save', {'root':root})[0], 409)

    def test_signed_out_and_changed_accounts_cannot_submit_stale_chat(self):
        with tempfile.TemporaryDirectory() as root, patch.object(workspace.codex_agent, 'executable', return_value='/bin/codex'):
            data = {'root':root, 'provider':'codex', 'account_id':'old-account'}
            with patch.object(workspace.codex_agent, 'account_status', return_value={'signed_in':False}):
                self.assertEqual(self.request('/api/chat', data)[0], 401)
            with patch.object(workspace.codex_agent, 'account_status', return_value={'signed_in':True,'account_id':'new-account'}):
                self.assertEqual(self.request('/api/chat', data)[0], 409)

    def test_auth_controls_require_workspace_token(self):
        for action in ['login', 'logout']:
            with patch.object(workspace.codex_agent, action) as change:
                self.assertEqual(self.request('/api/codex/' + action, {}, token='wrong')[0], 403)
                change.assert_not_called()

    def test_live_editing_requires_boolean(self):
        with tempfile.TemporaryDirectory() as root:
            code, result = self.request('/api/chat', {'root': root, 'live': 'yes'})
        self.assertEqual(code, 400)
        self.assertIn('Live editing', result['error'])

    def test_skill_list_uses_installed_catalog_and_requires_token(self):
        with tempfile.TemporaryDirectory() as root, patch.object(workspace.codex_skills, 'list_skills', return_value=[{'name':'user-expi','path':'/installed/SKILL.md','description':'Design flows'}]) as catalog:
            code, result = self.request('/api/skills', {'root':root})
            self.assertEqual(code, 200)
            self.assertEqual(result['skills'][0]['name'], 'user-expi')
            self.assertEqual(catalog.call_count, 1)
            self.assertEqual(self.request('/api/skills', {'root':root}, token='stale')[0], 403)
            self.assertEqual(catalog.call_count, 1)

    def test_unknown_skills_cannot_supply_arbitrary_files(self):
        with tempfile.TemporaryDirectory() as root, patch.object(workspace.codex_agent, 'executable', return_value='/bin/codex'), patch.object(workspace.codex_agent, 'account_status', return_value={'signed_in':True,'account_id':'account'}), patch.object(workspace.codex_skills, 'list_skills', return_value=[]):
            code, result = self.request('/api/chat', {'root':root,'provider':'codex','account_id':'account','skills':['../../private']})
            self.assertEqual(code, 400)
            self.assertIn('Skill is unavailable', result['error'])
            self.assertEqual(self.request('/api/chat', {'root':root,'provider':'codex','account_id':'account','skills':[{'name':'x','path':'/private'}]})[0], 400)

    def test_wrong_origins_remain_blocked(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.request('POST', '/api/stop', '{}', {'Content-Type':'application/json','X-Workspace-Token':workspace.TOKEN,'Origin':'https://example.com'})
        response = conn.getresponse()
        self.assertEqual(response.status, 403)
        response.read(); conn.close()

    def test_jev_bootstrap_contains_configuration_flag_and_chat_requires_boolean(self):
        with patch.object(workspace.jev_helper, 'configured', return_value=True):
            code, bootstrap = self.request('/api/bootstrap')
        self.assertEqual(code, 200)
        self.assertIs(bootstrap['jev'], True)
        self.assertNotIn('openrouter.key', json.dumps(bootstrap))
        with tempfile.TemporaryDirectory() as root:
            code, result = self.request('/api/chat', {'root':root, 'jev_enabled':'true'})
        self.assertEqual(code, 400)
        self.assertIn('enabled or disabled', result['error'])


if __name__ == '__main__':
    unittest.main()

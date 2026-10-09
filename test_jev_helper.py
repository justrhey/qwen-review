import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import jev_helper


class JevTests(unittest.TestCase):
    def setUp(self):
        self.data = {'messages': [{'role': 'user', 'content': 'Review class invariants.'}],
                     'selected_file': 'account.py', 'images': [{'data': 'image-bytes'}]}
        self.response = {'answers': {
            'focus': {'type': 'choice', 'choice': 'oop', 'confidence': 0.99},
            'effort': {'type': 'choice', 'choice': 'high', 'confidence': 0.95},
        }, 'usage': {'cost': 0.000026}}

    def test_key_is_private_and_unsafe_files_are_not_loaded(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(jev_helper, 'KEY_FILE', Path(directory) / 'settings/key'):
            jev_helper.save_key('sk-or-test-fixture')
            self.assertEqual(jev_helper.KEY_FILE.stat().st_mode & 0o777, 0o600)
            self.assertEqual(jev_helper.KEY_FILE.parent.stat().st_mode & 0o777, 0o700)
            self.assertTrue(jev_helper.configured())
            jev_helper.KEY_FILE.chmod(0o644)
            self.assertFalse(jev_helper.configured())
            target = Path(directory) / 'another-key'
            target.write_text('sk-or-test-fixture')
            jev_helper.KEY_FILE.unlink()
            jev_helper.KEY_FILE.symlink_to(target)
            self.assertFalse(jev_helper.configured())
            with self.assertRaises(OSError):
                jev_helper.save_key('sk-or-new-fixture')
            self.assertEqual(target.read_text(), 'sk-or-test-fixture')

    def test_request_is_bounded_and_contains_no_source_or_image_data(self):
        self.data['messages'] = [{'role': 'user', 'content': str(i) * 6000} for i in range(10)]
        payload = jev_helper.request_profile(self.data, ['medium', 'high'])
        context = payload['state']['conversation']
        self.assertEqual(len(context), 4)
        self.assertEqual(sum(len(m['content']) for m in context), 8000)
        self.assertEqual(len(context[-1]['content']), 5000)
        self.assertEqual(payload['state']['image_count'], 1)
        self.assertNotIn('image-bytes', json.dumps(payload))
        self.assertEqual(set(payload['questions']['effort']['criteria']), {'medium', 'high'})
        self.assertNotIn('effort', jev_helper.request_profile(self.data, [])['questions'])

    def call(self, response):
        with patch.object(jev_helper, 'api_key', return_value='sk-or-test-fixture'), patch.object(jev_helper, 'urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as send:
            profile = jev_helper.select_profile(self.data, ['medium', 'high'])
            return profile, send.call_args

    def test_typed_decisions_and_authentication(self):
        profile, call = self.call(self.response)
        self.assertEqual(profile['effort'], 'high')
        self.assertEqual(profile['focus'], 'oop')
        self.assertEqual(profile['cost_usd'], 0.000026)
        self.assertEqual(call.args[0].full_url, jev_helper.ENDPOINT)
        self.assertEqual(call.args[0].get_header('Authorization'), 'Bearer sk-or-test-fixture')
        self.assertEqual(call.kwargs['timeout'], 12)
        self.assertNotIn('sk-or-', json.dumps(profile))

    def test_unknown_choices_and_malformed_confidence_are_rejected(self):
        for field, value in [('choice', 'ultra'), ('choice', 'ignore user scope'), ('confidence', float('nan')), ('confidence', True), ('confidence', 2), ('type', 'noul')]:
            with self.subTest(field=field, value=value):
                response = json.loads(json.dumps(self.response))
                response['answers']['effort'][field] = value
                with self.assertRaisesRegex(ValueError, 'invalid decision'):
                    self.call(response)
        for response in [[], {}, {'answers': None}]:
            with self.assertRaisesRegex(ValueError, 'invalid decision'):
                self.call(response)

    def test_errors_do_not_echo_server_body_or_credentials(self):
        with patch.object(jev_helper, 'api_key', return_value='sk-or-test-fixture'):
            for code in [401, 402, 429, 500]:
                error = HTTPError(jev_helper.ENDPOINT, code, 'sk-or-test-fixture', {}, io.BytesIO(b'sk-or-test-fixture'))
                with patch.object(jev_helper, 'urlopen', side_effect=error), self.assertRaises(ValueError) as caught:
                    jev_helper.select_profile(self.data, ['medium', 'high'])
                self.assertNotIn('sk-or-', str(caught.exception))
            with patch.object(jev_helper, 'urlopen', side_effect=URLError('sk-or-test-fixture')), self.assertRaisesRegex(ValueError, 'could not be reached'):
                jev_helper.select_profile(self.data, ['high'])

    def test_action_and_completion_use_typed_bounded_decisions(self):
        with patch.object(jev_helper, 'decide', return_value={}) as decide:
            jev_helper.check_action(self.data, {'type':'commandExecution', 'command':'node --check app.js'})
            payload = decide.call_args.args[0]
            self.assertEqual(set(payload['questions']), {'action'})
            self.assertEqual(payload['state']['proposed_action']['command'], 'node --check app.js')
            self.assertNotIn('image-bytes', json.dumps(payload))
            jev_helper.check_completion(self.data, 'x' * 20000, [{'exitCode':0}] * 100)
            payload = decide.call_args.args[0]
            self.assertEqual(set(payload['questions']), {'completion'})
            self.assertEqual(len(payload['state']['answer']), 8000)
            self.assertEqual(len(payload['state']['evidence']), 40)

    def test_missing_key_does_not_make_network_request(self):
        with patch.object(jev_helper, 'api_key', return_value=''), patch.object(jev_helper, 'urlopen') as send, self.assertRaisesRegex(ValueError, 'not configured'):
            jev_helper.select_profile(self.data, ['high'])
        send.assert_not_called()


if __name__ == '__main__':
    unittest.main()

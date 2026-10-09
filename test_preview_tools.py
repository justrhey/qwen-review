import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import preview_tools


class PreviewTests(unittest.TestCase):
    def response(self, content):
        result = io.BytesIO(content.encode())
        result.url = 'http://127.0.0.1:8001/'
        return result

    def test_local_static_connection_is_idempotent_and_keeps_existing_html(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'workspace').mkdir()
            html = root / 'workspace/index.html'
            html.write_text('<html><head><title>Existing app</title></head><body>Keep me</body></html>')
            for _ in range(2):
                with patch.object(preview_tools, 'urlopen', return_value=self.response(html.read_text())):
                    self.assertTrue(preview_tools.connect(root, 'http://127.0.0.1:8001/', 8766)['connected'])
            self.assertEqual(html.read_text().count('data-arko-preview'), 1)
            self.assertIn('<body>Keep me</body>', html.read_text())
            self.assertIn('src="/workspace/arko-preview.js"', html.read_text())
            self.assertEqual((root / 'workspace/arko-preview.js').read_text(), preview_tools.BRIDGE.read_text())

    def test_dynamic_html_does_not_modify_project_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'index.html').write_text('<head></head>')
            with patch.object(preview_tools, 'urlopen', return_value=self.response('<head>HMR transformed</head>')):
                self.assertFalse(preview_tools.connect(root, 'http://127.0.0.1:8001/', 8766)['connected'])
            self.assertEqual((root / 'index.html').read_text(), '<head></head>')
            self.assertFalse((root / 'arko-preview.js').exists())

    def test_external_credential_and_workspace_urls_are_rejected(self):
        for url in ['http://example.com', 'http://user:secret@localhost:8001', 'file:///tmp/index.html', 'http://localhost:8766']:
            with patch.object(preview_tools, 'urlopen') as fetch, self.assertRaises(ValueError):
                preview_tools.connect(Path('/tmp'), url, 8766)
            fetch.assert_not_called()

    def test_existing_unrelated_bridge_file_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'index.html').write_text('<head></head>')
            (root / 'arko-preview.js').write_text('user code')
            with patch.object(preview_tools, 'urlopen', return_value=self.response('<head></head>')), self.assertRaises(ValueError):
                preview_tools.connect(root, 'http://127.0.0.1:8001/', 8766)
            self.assertEqual((root / 'arko-preview.js').read_text(), 'user code')

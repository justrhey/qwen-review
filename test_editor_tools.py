from pathlib import Path
import tempfile
import unittest

import editor_tools


class EditorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.file = self.root / 'app.py'
        self.file.write_text('print("hello")\n')
        self.file.chmod(0o755)

    def test_save_whole_unicode_file_preserves_mode(self):
        source = editor_tools.read_source(self.root, 'app.py')
        text = 'print("café")\n' * 260
        result = editor_tools.save_source(self.root, 'app.py', text, source['version'])
        self.assertEqual(self.file.read_text(), text)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o755)
        self.assertEqual(result['version'], editor_tools.read_source(self.root, 'app.py')['version'])

    def test_external_change_is_not_overwritten(self):
        source = editor_tools.read_source(self.root, 'app.py')
        self.file.write_text('newer user edit\n')
        with self.assertRaisesRegex(ValueError, 'changed on disk'):
            editor_tools.save_source(self.root, 'app.py', 'stale edit\n', source['version'])
        self.assertEqual(self.file.read_text(), 'newer user edit\n')

    def test_symlinks_traversal_and_binary_are_rejected(self):
        (self.root / 'link.py').symlink_to(self.file)
        for path in ['link.py', '../app.py', str(self.file)]:
            with self.assertRaises(ValueError):
                editor_tools.read_source(self.root, path)
        self.file.write_bytes(b'\0binary')
        with self.assertRaises(ValueError):
            editor_tools.read_source(self.root, 'app.py')

    def test_oversized_save_does_not_change_file(self):
        source = editor_tools.read_source(self.root, 'app.py')
        with self.assertRaises(ValueError):
            editor_tools.save_source(self.root, 'app.py', 'x' * 1048577, source['version'])
        self.assertEqual(self.file.read_text(), source['content'])


if __name__ == '__main__':
    unittest.main()

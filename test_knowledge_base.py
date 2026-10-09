from pathlib import Path
import tempfile
import unittest

import knowledge_base


class KnowledgeBaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qwen-knowledge-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "files"
        self.root.mkdir()
        self.database = Path(self.temp.name) / "knowledge.sqlite3"

    def test_rebuild_searches_text_and_skips_secrets_dependencies_and_binary(self):
        (self.root / "project.md").write_text("Huntly uses a customer portal.")
        (self.root / ".env").write_text("PASSWORD=hunter2")
        (self.root / "image.bin").write_bytes(b"customer portal\0binary")
        (self.root / "node_modules").mkdir()
        (self.root / "node_modules/package.js").write_text("customer portal")
        self.assertEqual(knowledge_base.rebuild(self.database, (self.root,)), 1)
        results = knowledge_base.search("Huntly portal", self.database)["results"]
        self.assertEqual([Path(item["path"]).name for item in results], ["project.md"])
        self.assertEqual(knowledge_base.search("hunter2", self.database)["results"], [])

    def test_missing_index_has_clear_empty_result(self):
        result = knowledge_base.search("anything", self.database)
        self.assertEqual(result["results"], [])
        self.assertIn("empty", result["error"])


if __name__ == "__main__":
    unittest.main()

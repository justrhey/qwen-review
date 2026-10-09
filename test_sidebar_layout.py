import unittest
from pathlib import Path


SIDEBAR = Path.home() / ".config/quickshell/ii/modules/ii/sidebarLeft/aiChat"


class SidebarLayoutTests(unittest.TestCase):
    def test_message_content_is_constrained_to_sidebar_width(self):
        source = (SIDEBAR / "AiMessage.qml").read_text()
        marker = "id: messageContentColumnLayout"
        block = source[source.index(marker):source.index(marker) + 100]
        self.assertIn("Layout.fillWidth: true", block)

    def test_code_row_uses_full_message_width(self):
        source = (SIDEBAR / "MessageCodeBlock.qml").read_text()
        marker = "RowLayout { // Line numbers and code"
        block = source[source.index(marker):source.index("Rectangle { // Line numbers", source.index(marker))]
        self.assertIn("Layout.fillWidth: true", block)

    def test_read_only_code_does_not_overwrite_stream_binding(self):
        source = (SIDEBAR / "MessageCodeBlock.qml").read_text()
        self.assertIn("if (root.editing) root.segmentContent = text", source)


if __name__ == "__main__":
    unittest.main()

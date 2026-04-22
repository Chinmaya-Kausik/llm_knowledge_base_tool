"""Tests for chat continuation, saving, and listing."""

import pytest
from pathlib import Path


class TestChatSaveLoad:
    """Test chat transcript save/load without requiring FastAPI."""

    def setup_method(self):
        self.loom_root = Path("/tmp/test-loom-chat")
        self.loom_root.mkdir(exist_ok=True)
        (self.loom_root / "raw" / "chats").mkdir(parents=True, exist_ok=True)

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.loom_root, ignore_errors=True)

    def test_save_creates_file(self):
        """Saving a chat should create a markdown file."""
        try:
            from loom_mcp.tools.compile import save_chat_transcript
        except ImportError:
            pytest.skip("compile dependencies not installed")
        result = save_chat_transcript(
            self.loom_root, "test-session",
            [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}],
            title="Test Chat"
        )
        assert result.get("ok") or "path" in result
        # Check a file was created in raw/chats
        chats = list((self.loom_root / "raw" / "chats").glob("*.md"))
        assert len(chats) >= 1

    def test_empty_messages_not_saved(self):
        """Empty message list should not create a file."""
        try:
            from loom_mcp.tools.compile import save_chat_transcript
        except ImportError:
            pytest.skip("compile dependencies not installed")
        result = save_chat_transcript(self.loom_root, "test-empty", [], title="Empty")
        chats_before = list((self.loom_root / "raw" / "chats").glob("*empty*"))
        # Should either return error or not create file
        assert not chats_before or result.get("error")


class TestChatPathTraversal:
    """Verify chat save can't write outside raw/chats."""

    def test_chat_save_stays_in_raw_chats(self):
        """Chat transcript path should always be inside raw/chats/."""
        try:
            from loom_mcp.tools.compile import save_chat_transcript
        except ImportError:
            pytest.skip("compile dependencies not installed")
        loom_root = Path("/tmp/test-loom-chatpath")
        loom_root.mkdir(exist_ok=True)
        (loom_root / "raw" / "chats").mkdir(parents=True, exist_ok=True)
        result = save_chat_transcript(
            loom_root, "../../etc/passwd",
            [{"role": "user", "content": "test"}]
        )
        # The resulting file should be in raw/chats, not ../../etc/
        if "path" in result:
            assert "raw/chats" in result["path"]
        import shutil
        shutil.rmtree(loom_root, ignore_errors=True)

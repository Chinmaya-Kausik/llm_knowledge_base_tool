"""Tests for context assembly edge cases."""

import pytest
from pathlib import Path

try:
    from loom_mcp.chat import build_system_prompt, sessions, _location_block_adaptive
    HAS_CHAT = True
except ImportError:
    HAS_CHAT = False

pytestmark = pytest.mark.skipif(not HAS_CHAT, reason="chat dependencies not installed")


class TestLocationBlockEdgeCases:
    def test_none_page_path_non_global_returns_none(self):
        """Non-global levels with None page_path should return None, not crash."""
        result = _location_block_adaptive(Path("/tmp"), None, "page", {}, 5000)
        assert result is None

    def test_none_page_path_global_does_not_crash(self):
        """Global level with None page_path should not crash on startswith."""
        # Should not raise AttributeError
        result = _location_block_adaptive(Path("/tmp"), None, "global", {}, 5000)
        # May return None if no wiki/meta/index.md exists, that's fine

    def test_vm_page_path_returns_vm_context(self):
        """VM page paths should return VM-specific context."""
        result = _location_block_adaptive(Path("/tmp"), "vm:test-vm", "page", {}, 5000)
        # Should mention VM (even if config not found)
        if result:
            assert "vm" in result.lower() or "VM" in result

    def test_empty_string_page_path_non_global(self):
        """Empty string page_path for non-global should return None."""
        result = _location_block_adaptive(Path("/tmp"), "", "page", {}, 5000)
        assert result is None


class TestBuildSystemPromptMetadata:
    def setup_method(self):
        self.loom_root = Path("/tmp/test-loom-ctx")
        self.loom_root.mkdir(exist_ok=True)

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.loom_root, ignore_errors=True)

    def test_metadata_stored_on_session(self):
        """build_system_prompt should store _prompt_metadata on the session."""
        sessions["test-meta"] = {"page_path": ""}
        build_system_prompt("test-meta", self.loom_root, "page")
        meta = sessions["test-meta"].get("_prompt_metadata")
        assert meta is not None
        assert "blocks" in meta
        assert "files" in meta
        del sessions["test-meta"]

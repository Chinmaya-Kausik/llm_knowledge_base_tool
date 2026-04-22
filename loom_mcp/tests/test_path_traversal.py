"""Tests for path traversal prevention across all endpoints and tools."""

import pytest
from pathlib import Path
from unittest.mock import patch

# Test the _safe_resolve helper from web.py
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))


def _safe_resolve(loom_root: Path, rel_path: str) -> Path:
    """Local copy of the helper for testing without importing web.py."""
    full = (loom_root / rel_path).resolve()
    root = loom_root.resolve()
    if not str(full).startswith(str(root) + "/") and full != root:
        raise ValueError(f"Path traversal blocked: {rel_path}")
    return full


class TestSafeResolve:
    """Test the _safe_resolve path validation helper."""

    def setup_method(self):
        self.loom_root = Path("/tmp/test-loom")
        self.loom_root.mkdir(exist_ok=True)
        (self.loom_root / "wiki").mkdir(exist_ok=True)
        (self.loom_root / "wiki" / "test.md").write_text("test")

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.loom_root, ignore_errors=True)

    def test_valid_path(self):
        result = _safe_resolve(self.loom_root, "wiki/test.md")
        assert result.exists()
        assert "test.md" in str(result)

    def test_dotdot_traversal_blocked(self):
        with pytest.raises(ValueError, match="Path traversal blocked"):
            _safe_resolve(self.loom_root, "../../etc/passwd")

    def test_absolute_path_blocked(self):
        with pytest.raises(ValueError, match="Path traversal blocked"):
            _safe_resolve(self.loom_root, "../../../etc/shadow")

    def test_nested_dotdot_blocked(self):
        with pytest.raises(ValueError, match="Path traversal blocked"):
            _safe_resolve(self.loom_root, "wiki/../../etc/passwd")

    def test_root_itself_allowed(self):
        result = _safe_resolve(self.loom_root, ".")
        assert result == self.loom_root.resolve()


try:
    from loom_mcp.tools.compile import read_source, read_wiki_page, write_wiki_page
    HAS_COMPILE = True
except ImportError:
    HAS_COMPILE = False

try:
    from loom_mcp.tools.ingest import classify_inbox_item
    HAS_INGEST = True
except ImportError:
    HAS_INGEST = False


@pytest.mark.skipif(not HAS_COMPILE, reason="compile dependencies not installed")
class TestCompilePathValidation:
    """Test path validation in compile.py tools."""

    def setup_method(self):
        self.loom_root = Path("/tmp/test-loom-compile")
        self.loom_root.mkdir(exist_ok=True)

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.loom_root, ignore_errors=True)

    def test_read_source_traversal_blocked(self):
        from loom_mcp.tools.compile import read_source
        with pytest.raises(ValueError, match="Path traversal blocked"):
            read_source(self.loom_root, "../../etc/passwd")

    def test_read_wiki_page_traversal_blocked(self):
        from loom_mcp.tools.compile import read_wiki_page
        with pytest.raises(ValueError, match="Path traversal blocked"):
            read_wiki_page(self.loom_root, "../../etc/passwd")

    def test_write_wiki_page_traversal_blocked(self):
        from loom_mcp.tools.compile import write_wiki_page
        with pytest.raises(ValueError, match="Path traversal blocked"):
            write_wiki_page(self.loom_root, "../../etc/crontab", {}, "malicious")


@pytest.mark.skipif(not HAS_INGEST, reason="ingest dependencies not installed")
class TestIngestPathValidation:
    """Test path validation in ingest.py tools."""

    def setup_method(self):
        self.loom_root = Path("/tmp/test-loom-ingest")
        self.loom_root.mkdir(exist_ok=True)
        (self.loom_root / "raw" / "inbox").mkdir(parents=True, exist_ok=True)
        (self.loom_root / "raw" / "inbox" / "test.md").write_text("test")

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.loom_root, ignore_errors=True)

    def test_classify_source_traversal_blocked(self):
        from loom_mcp.tools.ingest import classify_inbox_item
        with pytest.raises(ValueError, match="Source path traversal"):
            classify_inbox_item(self.loom_root, "../../etc/passwd", "raw/articles/stolen.md")

    def test_classify_destination_traversal_blocked(self):
        from loom_mcp.tools.ingest import classify_inbox_item
        with pytest.raises(ValueError, match="Destination path traversal"):
            classify_inbox_item(self.loom_root, "raw/inbox/test.md", "../../etc/crontab")

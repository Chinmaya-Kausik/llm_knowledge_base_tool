"""Tests for ingestion tools."""

import tempfile
from pathlib import Path
from unittest.mock import patch

from loom_mcp.lib.frontmatter import read_frontmatter
from loom_mcp.lib.hashing import content_hash
from loom_mcp.tools.ingest import classify_inbox_item, ingest_text, ingest_url


def _make_loom(tmp: str) -> Path:
    """Create a minimal loom directory structure."""
    root = Path(tmp) / "loom"
    (root / "raw" / "inbox").mkdir(parents=True)
    (root / "raw" / "articles").mkdir(parents=True)
    return root


def test_ingest_text_creates_file():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        result = ingest_text(loom, "Some knowledge here.", "My Note")

        assert result["content_hash"] == content_hash("Some knowledge here.")
        path = loom / result["path"]
        assert path.exists()

        meta, content = read_frontmatter(path)
        assert meta["title"] == "My Note"
        assert meta["compiled"] is False
        assert meta["content_type"] == "note"
        assert "Some knowledge here." in content


def test_ingest_text_unique_paths():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        r1 = ingest_text(loom, "First", "Same Title")
        r2 = ingest_text(loom, "Second", "Same Title")
        assert r1["path"] != r2["path"]


def test_ingest_text_frontmatter_has_required_fields():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        result = ingest_text(loom, "Content", "Title")
        meta, _ = read_frontmatter(loom / result["path"])

        for field in ["title", "captured", "content_type", "content_hash", "compiled"]:
            assert field in meta, f"Missing field: {field}"


def test_ingest_text_hash_matches_content():
    """Content hash should match the hash of the content body, not include frontmatter."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        text = "The quick brown fox"
        result = ingest_text(loom, text, "Fox")

        # Hash in result should match hash of input text
        assert result["content_hash"] == content_hash(text)

        # Hash in frontmatter should also match
        meta, _ = read_frontmatter(loom / result["path"])
        assert meta["content_hash"] == content_hash(text)


def test_ingest_url_with_mock():
    """Test URL ingestion with mocked trafilatura."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)

        mock_html = "<html><body><h1>Test Article</h1><p>Content here</p></body></html>"
        mock_md = "# Test Article\n\nContent here"

        with patch("loom_mcp.tools.ingest.trafilatura.fetch_url", return_value=mock_html):
            with patch("loom_mcp.tools.ingest.trafilatura.extract", return_value=mock_md):
                result = ingest_url(loom, "https://example.com/article")

        assert result["title"] == "Test Article"
        path = loom / result["path"]
        assert path.exists()

        meta, content = read_frontmatter(path)
        assert meta["source_url"] == "https://example.com/article"
        assert meta["compiled"] is False
        assert "Content here" in content


def test_classify_inbox_item():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        # Create a file in inbox
        ingest_text(loom, "Article content", "My Article")
        inbox_files = list((loom / "raw" / "inbox").glob("*.md"))
        assert len(inbox_files) == 1

        src = f"raw/inbox/{inbox_files[0].name}"
        dst = f"raw/articles/{inbox_files[0].name}"
        result = classify_inbox_item(loom, src, dst)

        assert result["old_path"] == src
        assert result["new_path"] == dst
        assert not (loom / src).exists()
        assert (loom / dst).exists()


def test_classify_inbox_item_missing_source():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        try:
            classify_inbox_item(loom, "raw/inbox/nonexistent.md", "raw/articles/nonexistent.md")
            assert False, "Should have raised FileNotFoundError"
        except FileNotFoundError:
            pass

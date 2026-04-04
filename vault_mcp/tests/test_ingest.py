"""Tests for ingestion tools."""

import tempfile
from pathlib import Path
from unittest.mock import patch

from vault_mcp.lib.frontmatter import read_frontmatter
from vault_mcp.lib.hashing import content_hash
from vault_mcp.tools.ingest import classify_inbox_item, ingest_text, ingest_url


def _make_vault(tmp: str) -> Path:
    """Create a minimal vault directory structure."""
    root = Path(tmp) / "vault"
    (root / "raw" / "inbox").mkdir(parents=True)
    (root / "raw" / "articles").mkdir(parents=True)
    return root


def test_ingest_text_creates_file():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        result = ingest_text(vault, "Some knowledge here.", "My Note")

        assert result["content_hash"] == content_hash("Some knowledge here.")
        path = vault / result["path"]
        assert path.exists()

        meta, content = read_frontmatter(path)
        assert meta["title"] == "My Note"
        assert meta["compiled"] is False
        assert meta["content_type"] == "note"
        assert "Some knowledge here." in content


def test_ingest_text_unique_paths():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        r1 = ingest_text(vault, "First", "Same Title")
        r2 = ingest_text(vault, "Second", "Same Title")
        assert r1["path"] != r2["path"]


def test_ingest_text_frontmatter_has_required_fields():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        result = ingest_text(vault, "Content", "Title")
        meta, _ = read_frontmatter(vault / result["path"])

        for field in ["title", "captured", "content_type", "content_hash", "compiled"]:
            assert field in meta, f"Missing field: {field}"


def test_ingest_text_hash_matches_content():
    """Content hash should match the hash of the content body, not include frontmatter."""
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        text = "The quick brown fox"
        result = ingest_text(vault, text, "Fox")

        # Hash in result should match hash of input text
        assert result["content_hash"] == content_hash(text)

        # Hash in frontmatter should also match
        meta, _ = read_frontmatter(vault / result["path"])
        assert meta["content_hash"] == content_hash(text)


def test_ingest_url_with_mock():
    """Test URL ingestion with mocked trafilatura."""
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)

        mock_html = "<html><body><h1>Test Article</h1><p>Content here</p></body></html>"
        mock_md = "# Test Article\n\nContent here"

        with patch("vault_mcp.tools.ingest.trafilatura.fetch_url", return_value=mock_html):
            with patch("vault_mcp.tools.ingest.trafilatura.extract", return_value=mock_md):
                result = ingest_url(vault, "https://example.com/article")

        assert result["title"] == "Test Article"
        path = vault / result["path"]
        assert path.exists()

        meta, content = read_frontmatter(path)
        assert meta["source_url"] == "https://example.com/article"
        assert meta["compiled"] is False
        assert "Content here" in content


def test_classify_inbox_item():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        # Create a file in inbox
        ingest_text(vault, "Article content", "My Article")
        inbox_files = list((vault / "raw" / "inbox").glob("*.md"))
        assert len(inbox_files) == 1

        src = f"raw/inbox/{inbox_files[0].name}"
        dst = f"raw/articles/{inbox_files[0].name}"
        result = classify_inbox_item(vault, src, dst)

        assert result["old_path"] == src
        assert result["new_path"] == dst
        assert not (vault / src).exists()
        assert (vault / dst).exists()


def test_classify_inbox_item_missing_source():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        try:
            classify_inbox_item(vault, "raw/inbox/nonexistent.md", "raw/articles/nonexistent.md")
            assert False, "Should have raised FileNotFoundError"
        except FileNotFoundError:
            pass

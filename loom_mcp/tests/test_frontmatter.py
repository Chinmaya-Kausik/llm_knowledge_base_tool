"""Tests for frontmatter read/write/validate."""

import tempfile
from pathlib import Path

from loom_mcp.lib.frontmatter import (
    read_frontmatter,
    validate_raw_frontmatter,
    validate_wiki_frontmatter,
    write_frontmatter,
)


def test_write_and_read_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "test.md"
        metadata = {"title": "Test Page", "tags": ["a", "b"]}
        content = "# Hello\n\nSome content here."

        write_frontmatter(path, metadata, content)
        read_meta, read_content = read_frontmatter(path)

        assert read_meta["title"] == "Test Page"
        assert read_meta["tags"] == ["a", "b"]
        assert "# Hello" in read_content
        assert "Some content here." in read_content


def test_write_creates_parent_dirs():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "deep" / "nested" / "page.md"
        write_frontmatter(path, {"title": "Deep"}, "content")
        assert path.exists()


def test_validate_wiki_frontmatter_all_fields():
    metadata = {
        "title": "Test", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": "abc", "compiler_model": "claude-sonnet",
        "compiler_prompt_version": "v1.0", "sources": [],
        "tags": [], "related": [], "confidence": "high",
    }
    assert validate_wiki_frontmatter(metadata) == []


def test_validate_wiki_frontmatter_missing():
    assert "title" in validate_wiki_frontmatter({})
    assert len(validate_wiki_frontmatter({})) == 12


def test_validate_raw_frontmatter_all_fields():
    metadata = {
        "title": "Test", "captured": "2026-04-04",
        "content_type": "article", "content_hash": "abc", "compiled": False,
    }
    assert validate_raw_frontmatter(metadata) == []


def test_validate_raw_frontmatter_missing():
    missing = validate_raw_frontmatter({"title": "Test"})
    assert "captured" in missing
    assert "title" not in missing

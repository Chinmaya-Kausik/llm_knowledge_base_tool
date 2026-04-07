"""Tests for compilation support tools."""

import json
import tempfile
from pathlib import Path

from loom_mcp.lib.frontmatter import read_frontmatter, write_frontmatter
from loom_mcp.lib.hashing import content_hash
from loom_mcp.tools.compile import (
    get_changed_sources,
    get_glossary,
    get_page_registry,
    mark_source_compiled,
    read_source,
    read_wiki_page,
    update_glossary,
    write_wiki_page,
)


def _make_loom(tmp: str) -> Path:
    root = Path(tmp) / "loom"
    (root / "raw" / "inbox").mkdir(parents=True)
    (root / "wiki" / "concepts").mkdir(parents=True)
    (root / "wiki" / "meta").mkdir(parents=True)
    (root / "wiki" / "meta" / "page-registry.json").write_text('{"pages": []}')
    write_frontmatter(
        root / "wiki" / "meta" / "glossary.md",
        {"title": "Glossary", "type": "structure-note", "status": "compiled",
         "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z"},
        "# Glossary\n\nCanonical terms.\n",
    )
    return root


def _add_raw_source(loom: Path, name: str, content: str, compiled: bool = False) -> str:
    """Add a raw source file, return relative path."""
    rel = f"raw/inbox/{name}.md"
    write_frontmatter(
        loom / rel,
        {"title": name, "captured": "2026-04-04", "content_type": "note",
         "content_hash": content_hash(content), "compiled": compiled},
        content,
    )
    return rel


# --- get_changed_sources ---

def test_get_changed_sources_new():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_raw_source(loom, "new-source", "Some content", compiled=False)
        changed = get_changed_sources(loom)
        assert len(changed) == 1
        assert changed[0]["status"] == "new"


def test_get_changed_sources_modified():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        rel = _add_raw_source(loom, "mod-source", "Original", compiled=True)
        # Modify the content without updating the hash
        meta, _ = read_frontmatter(loom / rel)
        write_frontmatter(loom / rel, meta, "Modified content")
        changed = get_changed_sources(loom)
        assert len(changed) == 1
        assert changed[0]["status"] == "modified"


def test_get_changed_sources_up_to_date():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_raw_source(loom, "done-source", "Content", compiled=True)
        changed = get_changed_sources(loom)
        assert len(changed) == 0


# --- get_page_registry ---

def test_get_page_registry_empty():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        registry = get_page_registry(loom)
        assert registry == {"pages": []}


# --- get_glossary ---

def test_get_glossary():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        glossary = get_glossary(loom)
        assert "Glossary" in glossary


# --- read_source / read_wiki_page ---

def test_read_source():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        rel = _add_raw_source(loom, "test-src", "Hello world")
        result = read_source(loom, rel)
        assert result["frontmatter"]["title"] == "test-src"
        assert "Hello world" in result["content"]


def test_read_source_missing():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        try:
            read_source(loom, "raw/inbox/missing.md")
            assert False, "Should raise"
        except FileNotFoundError:
            pass


# --- write_wiki_page ---

def test_write_wiki_page_creates_file_and_updates_registry():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        fm = {
            "title": "Transformers", "type": "concept", "status": "compiled",
            "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
            "source_hash": "abc123", "compiler_model": "claude-sonnet",
            "compiler_prompt_version": "v1.0", "sources": [],
            "tags": ["ml"], "related": [], "aliases": ["Vaswani"],
            "confidence": "high",
        }
        result = write_wiki_page(loom, "wiki/concepts/transformers.md", fm, "# Transformers\n\nContent.")
        assert result["is_new"] is True
        assert result["title"] == "Transformers"
        assert (loom / "wiki" / "concepts" / "transformers.md").exists()

        # Registry updated
        registry = json.loads((loom / "wiki" / "meta" / "page-registry.json").read_text())
        assert len(registry["pages"]) == 1
        assert registry["pages"][0]["title"] == "Transformers"
        assert registry["pages"][0]["aliases"] == ["Vaswani"]


def test_write_wiki_page_update_existing():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        fm = {"title": "Test", "type": "concept", "status": "compiled",
              "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
              "source_hash": "a", "compiler_model": "claude", "compiler_prompt_version": "v1",
              "sources": [], "tags": [], "related": [], "aliases": [], "confidence": "high"}

        write_wiki_page(loom, "wiki/concepts/test.md", fm, "V1")
        fm["source_hash"] = "b"
        result = write_wiki_page(loom, "wiki/concepts/test.md", fm, "V2")
        assert result["is_new"] is False

        registry = json.loads((loom / "wiki" / "meta" / "page-registry.json").read_text())
        assert len(registry["pages"]) == 1  # Not duplicated


# --- mark_source_compiled ---

def test_mark_source_compiled():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        rel = _add_raw_source(loom, "to-compile", "Content", compiled=False)
        result = mark_source_compiled(loom, rel, "newhash")
        assert result["hash"] == "newhash"

        meta, _ = read_frontmatter(loom / rel)
        assert meta["compiled"] is True
        assert meta["content_hash"] == "newhash"


# --- update_glossary ---

def test_update_glossary_adds_term():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        result = update_glossary(loom, "Transformer", "A neural network architecture.")
        assert result["added"] is True

        glossary = get_glossary(loom)
        assert "## Transformer" in glossary
        assert "neural network architecture" in glossary


def test_update_glossary_no_duplicate():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        update_glossary(loom, "Transformer", "First def.")
        result = update_glossary(loom, "Transformer", "Second def.")
        assert result["added"] is False

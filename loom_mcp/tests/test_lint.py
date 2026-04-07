"""Tests for linting tools."""

import json
import tempfile
from pathlib import Path

from loom_mcp.lib.frontmatter import write_frontmatter
from loom_mcp.lib.hashing import content_hash
from loom_mcp.lib.registry import save_registry
from loom_mcp.tools.lint import (
    check_terminology,
    find_missing_concepts,
    find_orphan_pages,
    find_stale_pages,
    generate_health_report,
    validate_links,
)


def _make_loom(tmp: str) -> Path:
    root = Path(tmp) / "loom"
    (root / "raw" / "inbox").mkdir(parents=True)
    (root / "wiki" / "concepts").mkdir(parents=True)
    (root / "wiki" / "meta").mkdir(parents=True)
    save_registry(root / "wiki" / "meta" / "page-registry.json", {"pages": []})
    write_frontmatter(
        root / "wiki" / "meta" / "glossary.md",
        {"title": "Glossary", "type": "structure-note", "status": "compiled",
         "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z"},
        "# Glossary\n\n## machine learning\n\nA field of AI.\n",
    )
    return root


def _add_wiki_page(loom: Path, rel_path: str, title: str, content: str,
                   sources: list | None = None, related: list | None = None,
                   tags: list | None = None, aliases: list | None = None) -> None:
    fm = {
        "title": title, "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": "abc", "compiler_model": "claude", "compiler_prompt_version": "v1",
        "sources": sources or [], "tags": tags or [], "related": related or [],
        "aliases": aliases or [], "confidence": "high",
    }
    write_frontmatter(loom / rel_path, fm, content)

    # Update registry
    reg_path = loom / "wiki" / "meta" / "page-registry.json"
    reg = json.loads(reg_path.read_text())
    reg["pages"].append({"title": title, "path": rel_path, "aliases": aliases or []})
    save_registry(reg_path, reg)


# --- validate_links ---

def test_validate_links_no_broken():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_wiki_page(loom, "wiki/concepts/a.md", "A", "Links to [[B]].")
        _add_wiki_page(loom, "wiki/concepts/b.md", "B", "No links.")
        broken = validate_links(loom)
        assert len(broken) == 0


def test_validate_links_broken():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_wiki_page(loom, "wiki/concepts/a.md", "A", "Links to [[NonExistent]].")
        broken = validate_links(loom)
        assert len(broken) == 1
        assert broken[0]["link"] == "NonExistent"
        assert broken[0]["status"] == "broken"


def test_validate_links_alias_resolution():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_wiki_page(loom, "wiki/concepts/transformer.md", "Transformers",
                       "Content.", aliases=["Vaswani architecture"])
        _add_wiki_page(loom, "wiki/concepts/bert.md", "BERT",
                       "Based on [[Vaswani architecture]].")
        broken = validate_links(loom)
        assert len(broken) == 0


# --- find_stale_pages ---

def test_find_stale_pages_none():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        src_content = "Source content"
        src_hash = content_hash(src_content)
        write_frontmatter(
            loom / "raw/inbox/src.md",
            {"title": "Src", "captured": "2026-04-04", "content_type": "note",
             "content_hash": src_hash, "compiled": True},
            src_content,
        )
        _add_wiki_page(loom, "wiki/concepts/derived.md", "Derived", "Derived content.",
                       sources=[{"path": "raw/inbox/src.md", "hash": src_hash}])
        stale = find_stale_pages(loom)
        assert len(stale) == 0


def test_find_stale_pages_hash_mismatch():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        write_frontmatter(
            loom / "raw/inbox/src.md",
            {"title": "Src", "captured": "2026-04-04", "content_type": "note",
             "content_hash": "old", "compiled": True},
            "Updated source content",
        )
        _add_wiki_page(loom, "wiki/concepts/derived.md", "Derived", "Content.",
                       sources=[{"path": "raw/inbox/src.md", "hash": "old_hash"}])
        stale = find_stale_pages(loom)
        assert len(stale) == 1


def test_find_stale_pages_missing_source():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_wiki_page(loom, "wiki/concepts/derived.md", "Derived", "Content.",
                       sources=[{"path": "raw/inbox/deleted.md", "hash": "abc"}])
        stale = find_stale_pages(loom)
        assert len(stale) == 1
        assert stale[0]["actual_hash"] == "FILE_MISSING"


# --- find_orphan_pages ---

def test_find_orphan_pages():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_wiki_page(loom, "wiki/concepts/a.md", "A", "Links to [[B]].")
        _add_wiki_page(loom, "wiki/concepts/b.md", "B", "No links out.")
        _add_wiki_page(loom, "wiki/concepts/c.md", "C", "Orphan, no links in.")

        orphans = find_orphan_pages(loom)
        # A is orphan (nobody links to A), C is orphan
        # B is not orphan (A links to B)
        assert "wiki/concepts/b.md" not in orphans
        assert "wiki/concepts/a.md" in orphans
        assert "wiki/concepts/c.md" in orphans


# --- find_missing_concepts ---

def test_find_missing_concepts():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_wiki_page(loom, "wiki/concepts/a.md", "A", "Content.",
                       related=["[[B]]", "[[Missing Concept]]"])
        _add_wiki_page(loom, "wiki/concepts/b.md", "B", "Content.")

        missing = find_missing_concepts(loom)
        assert "Missing Concept" in missing
        assert "B" not in missing


# --- check_terminology ---

def test_check_terminology_known_terms():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_wiki_page(loom, "wiki/concepts/a.md", "A", "Content.",
                       tags=["machine-learning"])
        unknown = check_terminology(loom, "wiki/concepts/a.md")
        assert len(unknown) == 0


def test_check_terminology_unknown_terms():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_wiki_page(loom, "wiki/concepts/a.md", "A", "Content.",
                       tags=["quantum-computing"])
        unknown = check_terminology(loom, "wiki/concepts/a.md")
        assert "quantum computing" in unknown


# --- generate_health_report ---

def test_generate_health_report():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        _add_wiki_page(loom, "wiki/concepts/a.md", "A", "Links to [[Missing]].")

        result = generate_health_report(loom)
        assert result["broken_links"] == 1
        assert result["total_issues"] >= 1
        assert (loom / "wiki" / "meta" / "health.md").exists()

"""Tests for master index and operation log."""

import tempfile
from pathlib import Path

from vault_mcp.lib.frontmatter import read_frontmatter, write_frontmatter
from vault_mcp.lib.hashing import content_hash
from vault_mcp.lib.registry import save_registry
from vault_mcp.tools.compile import append_log, update_master_index


def _make_vault(tmp: str) -> Path:
    root = Path(tmp) / "vault"
    (root / "wiki" / "concepts").mkdir(parents=True)
    (root / "wiki" / "answers").mkdir(parents=True)
    (root / "wiki" / "meta").mkdir(parents=True)
    save_registry(root / "wiki" / "meta" / "page-registry.json", {"pages": []})
    write_frontmatter(
        root / "wiki" / "meta" / "glossary.md",
        {"title": "Glossary", "type": "structure-note", "status": "compiled",
         "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z"},
        "# Glossary\n",
    )
    return root


def _add_page(vault: Path, rel_path: str, title: str, page_type: str,
              tags: list | None = None, content: str = "Some content.") -> None:
    fm = {
        "title": title, "type": page_type, "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": "abc", "compiler_model": "claude", "compiler_prompt_version": "v1",
        "sources": [], "tags": tags or [], "related": [],
        "aliases": [], "confidence": "high",
    }
    write_frontmatter(vault / rel_path, fm, content)

    reg_path = vault / "wiki" / "meta" / "page-registry.json"
    import json
    reg = json.loads(reg_path.read_text())
    reg["pages"].append({"title": title, "path": rel_path, "aliases": []})
    reg_path.write_text(json.dumps(reg))


# --- append_log ---

def test_append_log_creates_file():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        result = append_log(vault, "ingest", "Test Article")
        assert result["entry_type"] == "ingest"
        assert result["title"] == "Test Article"

        log_path = vault / "wiki" / "meta" / "log.md"
        assert log_path.exists()
        content = log_path.read_text()
        assert "## [" in content
        assert "ingest | Test Article" in content


def test_append_log_appends():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        append_log(vault, "ingest", "First")
        append_log(vault, "compile", "Second")
        append_log(vault, "query", "Third")

        content = (vault / "wiki" / "meta" / "log.md").read_text()
        assert content.count("## [") == 3
        assert "ingest | First" in content
        assert "compile | Second" in content
        assert "query | Third" in content


def test_append_log_with_details():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        append_log(vault, "lint", "Health check", "Found 3 broken links")
        content = (vault / "wiki" / "meta" / "log.md").read_text()
        assert "3 broken links" in content


def test_append_log_grepable():
    """Log entries should be parseable with grep."""
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        append_log(vault, "ingest", "Article A")
        append_log(vault, "compile", "Article A")
        append_log(vault, "ingest", "Article B")

        content = (vault / "wiki" / "meta" / "log.md").read_text()
        # grep "^## \[" should match all entries
        entries = [l for l in content.split("\n") if l.startswith("## [")]
        assert len(entries) == 3


# --- update_master_index ---

def test_master_index_empty():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        result = update_master_index(vault)
        assert result["total_pages"] == 0
        assert (vault / "wiki" / "meta" / "index.md").exists()


def test_master_index_with_pages():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        _add_page(vault, "wiki/concepts/transformers.md", "Transformers", "concept",
                  tags=["ml"], content="The Transformer architecture uses attention.")
        _add_page(vault, "wiki/concepts/bert.md", "BERT", "concept",
                  tags=["ml", "nlp"], content="BERT is a pre-trained language model.")
        _add_page(vault, "wiki/answers/q1.md", "What is attention?", "answer",
                  content="Attention allows models to focus on relevant parts.")

        result = update_master_index(vault)
        assert result["total_pages"] == 3
        assert result["categories"]["concept"] == 2
        assert result["categories"]["answer"] == 1

        # Check index content
        _, content = read_frontmatter(vault / "wiki" / "meta" / "index.md")
        assert "[[Transformers]]" in content
        assert "[[BERT]]" in content
        assert "[[What is attention?]]" in content
        assert "Concepts (2)" in content
        assert "Answers (1)" in content


def test_master_index_includes_summaries():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        _add_page(vault, "wiki/concepts/test.md", "Test Concept", "concept",
                  content="This is the first paragraph of the test concept.\n\nSecond paragraph.")

        update_master_index(vault)
        _, content = read_frontmatter(vault / "wiki" / "meta" / "index.md")
        assert "first paragraph" in content


def test_master_index_includes_tags():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        _add_page(vault, "wiki/concepts/a.md", "Alpha", "concept", tags=["ml", "nlp"])

        update_master_index(vault)
        _, content = read_frontmatter(vault / "wiki" / "meta" / "index.md")
        assert "ml" in content
        assert "nlp" in content


def test_master_index_preserves_created():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        _add_page(vault, "wiki/concepts/a.md", "A", "concept")
        update_master_index(vault)

        meta1, _ = read_frontmatter(vault / "wiki" / "meta" / "index.md")
        created1 = meta1["created"]

        _add_page(vault, "wiki/concepts/b.md", "B", "concept")
        update_master_index(vault)

        meta2, _ = read_frontmatter(vault / "wiki" / "meta" / "index.md")
        assert meta2["created"] == created1

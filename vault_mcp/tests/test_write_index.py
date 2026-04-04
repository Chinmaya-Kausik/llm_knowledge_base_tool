"""Tests for write_index tool."""

import tempfile
from pathlib import Path

from vault_mcp.lib.frontmatter import read_frontmatter
from vault_mcp.tools.search import read_index, write_index


def _make_vault(tmp: str) -> Path:
    root = Path(tmp) / "vault"
    (root / "wiki" / "indexes").mkdir(parents=True)
    return root


def test_write_index_creates_file():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        result = write_index(vault, "Machine Learning", "# ML Index\n\n- [[Transformers]]\n- [[BERT]]\n")
        assert result["created"] is True
        assert result["topic"] == "Machine Learning"
        assert (vault / result["path"]).exists()


def test_write_index_readable():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        write_index(vault, "Machine Learning", "# ML Index\n\n- [[Transformers]]\n")
        content = read_index(vault, "machine-learning")
        assert "Transformers" in content


def test_write_index_update_preserves_created():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        write_index(vault, "NLP", "Version 1")
        meta1, _ = read_frontmatter(vault / "wiki" / "indexes" / "nlp.md")
        created1 = meta1["created"]

        write_index(vault, "NLP", "Version 2")
        meta2, content2 = read_frontmatter(vault / "wiki" / "indexes" / "nlp.md")
        assert meta2["created"] == created1
        assert "Version 2" in content2


def test_write_index_update_not_created():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        write_index(vault, "AI", "First")
        result = write_index(vault, "AI", "Second")
        assert result["created"] is False


def test_write_index_frontmatter():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        write_index(vault, "Deep Learning", "Content here")
        meta, _ = read_frontmatter(vault / "wiki" / "indexes" / "deep-learning.md")
        assert meta["type"] == "index"
        assert meta["status"] == "compiled"
        assert "Deep Learning" in meta["title"]

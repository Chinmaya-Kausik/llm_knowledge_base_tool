"""Tests for search tools."""

import subprocess
import tempfile
from pathlib import Path

import pytest

from vault_mcp.lib.frontmatter import write_frontmatter
from vault_mcp.tools.search import read_index, ripgrep_search

# Check if ripgrep is available
try:
    HAS_RG = subprocess.run(["rg", "--version"], capture_output=True).returncode == 0
except FileNotFoundError:
    HAS_RG = False


def _make_vault(tmp: str) -> Path:
    root = Path(tmp) / "vault"
    (root / "raw" / "inbox").mkdir(parents=True)
    (root / "wiki" / "concepts").mkdir(parents=True)
    (root / "wiki" / "indexes").mkdir(parents=True)
    return root


@pytest.mark.skipif(not HAS_RG, reason="ripgrep not installed")
def test_ripgrep_search_finds_match():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        (vault / "wiki" / "concepts" / "test.md").write_text("---\ntitle: Test\n---\nTransformers use attention.\n")
        results = ripgrep_search(vault, "attention", scope="wiki")
        assert len(results) >= 1
        assert any("attention" in r["context"] for r in results)


@pytest.mark.skipif(not HAS_RG, reason="ripgrep not installed")
def test_ripgrep_search_scope_filtering():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        (vault / "raw" / "inbox" / "note.md").write_text("---\ntitle: Note\n---\nUniqueRawTerm.\n")
        (vault / "wiki" / "concepts" / "page.md").write_text("---\ntitle: Page\n---\nSomething else.\n")
        results = ripgrep_search(vault, "UniqueRawTerm", scope="wiki")
        assert len(results) == 0
        results = ripgrep_search(vault, "UniqueRawTerm", scope="raw")
        assert len(results) >= 1


@pytest.mark.skipif(not HAS_RG, reason="ripgrep not installed")
def test_ripgrep_search_no_results():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        (vault / "wiki" / "concepts" / "test.md").write_text("---\ntitle: Test\n---\nHello.\n")
        results = ripgrep_search(vault, "zzz_nonexistent_zzz", scope="wiki")
        assert len(results) == 0


def test_read_index_found():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        write_frontmatter(
            vault / "wiki" / "indexes" / "machine-learning.md",
            {"title": "Machine Learning Index", "type": "index"},
            "# Machine Learning\n\n- [[Transformers]]\n- [[BERT]]\n",
        )
        content = read_index(vault, "machine-learning")
        assert "Transformers" in content


def test_read_index_not_found():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_vault(tmp)
        result = read_index(vault, "nonexistent")
        assert "not found" in result.lower()

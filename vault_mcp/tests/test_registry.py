"""Tests for page registry management."""

import json
import tempfile
from pathlib import Path

from vault_mcp.lib.registry import add_page, find_page, load_registry, remove_page, save_registry


def test_load_missing_file():
    registry = load_registry(Path("/nonexistent/registry.json"))
    assert registry == {"pages": []}


def test_save_and_load_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "registry.json"
        registry = {"pages": [{"title": "Test", "path": "concepts/test.md", "aliases": []}]}
        save_registry(path, registry)
        loaded = load_registry(path)
        assert loaded == registry


def test_add_page_new():
    registry = {"pages": []}
    registry = add_page(registry, "Foo", "concepts/foo.md", ["Bar"])
    assert len(registry["pages"]) == 1
    assert registry["pages"][0]["title"] == "Foo"
    assert registry["pages"][0]["aliases"] == ["Bar"]


def test_add_page_update_existing():
    registry = {"pages": [{"title": "Old", "path": "concepts/foo.md", "aliases": []}]}
    registry = add_page(registry, "New", "concepts/foo.md", ["Alias"])
    assert len(registry["pages"]) == 1
    assert registry["pages"][0]["title"] == "New"


def test_remove_page():
    registry = {"pages": [{"title": "A", "path": "a.md", "aliases": []}, {"title": "B", "path": "b.md", "aliases": []}]}
    registry = remove_page(registry, "a.md")
    assert len(registry["pages"]) == 1
    assert registry["pages"][0]["title"] == "B"


def test_find_page_by_title():
    registry = {"pages": [{"title": "Transformers", "path": "t.md", "aliases": ["Vaswani"]}]}
    page = find_page(registry, "Transformers")
    assert page is not None
    assert page["path"] == "t.md"


def test_find_page_by_alias():
    registry = {"pages": [{"title": "Transformers", "path": "t.md", "aliases": ["Vaswani"]}]}
    page = find_page(registry, "Vaswani")
    assert page is not None


def test_find_page_case_insensitive():
    registry = {"pages": [{"title": "BERT", "path": "b.md", "aliases": []}]}
    assert find_page(registry, "bert") is not None


def test_find_page_not_found():
    registry = {"pages": []}
    assert find_page(registry, "Missing") is None

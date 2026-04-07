"""Tests for wiki-link parsing and resolution."""

import tempfile
from pathlib import Path

from loom_mcp.lib.links import WikiLink, find_backlinks, parse_links, resolve_link


def test_parse_simple_link():
    links = parse_links("See [[Transformers]] for details.")
    assert len(links) == 1
    assert links[0].target == "Transformers"
    assert links[0].display == "Transformers"


def test_parse_aliased_link():
    links = parse_links("See [[Transformers|transformer architecture]] here.")
    assert len(links) == 1
    assert links[0].target == "Transformers"
    assert links[0].display == "transformer architecture"


def test_parse_multiple_links():
    text = "[[BERT]] and [[GPT]] are both based on [[Transformers]]."
    links = parse_links(text)
    assert len(links) == 3
    targets = {l.target for l in links}
    assert targets == {"BERT", "GPT", "Transformers"}


def test_parse_no_links():
    assert parse_links("No links here.") == []


def test_parse_preserves_raw():
    links = parse_links("[[Foo|Bar]]")
    assert links[0].raw == "[[Foo|Bar]]"


def test_resolve_link_by_title():
    registry = {"pages": [{"title": "Transformers", "path": "concepts/transformers.md", "aliases": []}]}
    result = resolve_link("Transformers", registry, Path("/wiki"))
    assert result == Path("/wiki/concepts/transformers.md")


def test_resolve_link_by_alias():
    registry = {"pages": [{"title": "Transformers", "path": "concepts/transformers.md", "aliases": ["Vaswani architecture"]}]}
    result = resolve_link("Vaswani architecture", registry, Path("/wiki"))
    assert result == Path("/wiki/concepts/transformers.md")


def test_resolve_link_case_insensitive():
    registry = {"pages": [{"title": "BERT", "path": "concepts/bert.md", "aliases": []}]}
    result = resolve_link("bert", registry, Path("/wiki"))
    assert result == Path("/wiki/concepts/bert.md")


def test_resolve_link_not_found():
    registry = {"pages": []}
    assert resolve_link("Missing", registry, Path("/wiki")) is None


def test_find_backlinks():
    with tempfile.TemporaryDirectory() as tmp:
        wiki = Path(tmp)
        (wiki / "a.md").write_text("---\ntitle: A\n---\nLinks to [[B]].\n")
        (wiki / "b.md").write_text("---\ntitle: B\n---\nNo links here.\n")
        (wiki / "c.md").write_text("---\ntitle: C\n---\nAlso links to [[B]].\n")

        backlinks = find_backlinks("B", wiki)
        assert len(backlinks) == 2
        names = {b.name for b in backlinks}
        assert names == {"a.md", "c.md"}

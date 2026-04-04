"""Tests for the web API server."""

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from vault_mcp.lib.frontmatter import read_frontmatter, write_frontmatter
from vault_mcp.lib.hashing import content_hash
from vault_mcp.lib.registry import save_registry


@pytest.fixture
def vault_app(tmp_path):
    """Create a test vault with sample data and return a TestClient."""
    root = tmp_path / "vault"
    (root / "raw" / "inbox").mkdir(parents=True)
    (root / "wiki" / "concepts").mkdir(parents=True)
    (root / "wiki" / "summaries").mkdir(parents=True)
    (root / "wiki" / "meta").mkdir(parents=True)

    write_frontmatter(
        root / "wiki" / "meta" / "glossary.md",
        {"title": "Glossary", "type": "structure-note", "status": "compiled",
         "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z"},
        "# Glossary\n\n## machine learning\n\nA field of AI.\n",
    )

    save_registry(root / "wiki" / "meta" / "page-registry.json", {
        "pages": [
            {"title": "Alpha", "path": "wiki/concepts/alpha.md", "aliases": ["A"]},
            {"title": "Beta", "path": "wiki/concepts/beta.md", "aliases": []},
        ]
    })

    src_content = "Raw source for alpha"
    src_hash = content_hash(src_content)
    write_frontmatter(root / "raw" / "inbox" / "src.md", {
        "title": "Source", "captured": "2026-04-04", "content_type": "note",
        "content_hash": src_hash, "compiled": True,
    }, src_content)

    write_frontmatter(root / "wiki" / "concepts" / "alpha.md", {
        "title": "Alpha", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": src_hash, "compiler_model": "claude",
        "compiler_prompt_version": "v1", "sources": [{"path": "raw/inbox/src.md", "hash": src_hash}],
        "tags": ["machine-learning"], "related": ["[[Beta]]"],
        "aliases": ["A"], "confidence": "high",
    }, "# Alpha\n\nLinks to [[Beta]].\n")

    write_frontmatter(root / "wiki" / "concepts" / "beta.md", {
        "title": "Beta", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": "xyz", "compiler_model": "claude",
        "compiler_prompt_version": "v1", "sources": [],
        "tags": ["machine-learning"], "related": ["[[Alpha]]"],
        "aliases": [], "confidence": "medium",
    }, "# Beta\n\nLinks to [[Alpha]].\n")

    import vault_mcp.web as web_module
    original_root = web_module.VAULT_ROOT
    original_layout = web_module.LAYOUT_FILE
    web_module.VAULT_ROOT = root
    web_module.LAYOUT_FILE = root / "wiki" / "meta" / "canvas-layout.json"

    client = TestClient(web_module.app)
    yield client, root

    web_module.VAULT_ROOT = original_root
    web_module.LAYOUT_FILE = original_layout


def test_graph_nodes_and_edges(vault_app):
    client, root = vault_app
    r = client.get("/api/graph")
    assert r.status_code == 200
    data = r.json()
    assert len(data["nodes"]) == 2
    assert len(data["edges"]) == 2


def test_registry(vault_app):
    client, root = vault_app
    assert len(client.get("/api/registry").json()["pages"]) == 2


def test_page_read(vault_app):
    client, root = vault_app
    r = client.get("/api/page/wiki/concepts/alpha.md")
    assert r.status_code == 200
    assert r.json()["frontmatter"]["title"] == "Alpha"


def test_page_not_found(vault_app):
    client, root = vault_app
    assert client.get("/api/page/wiki/concepts/missing.md").status_code == 404


def test_tree(vault_app):
    client, root = vault_app
    r = client.get("/api/tree")
    assert r.json()["name"] == "wiki"


def test_health(vault_app):
    client, root = vault_app
    assert "total_issues" in client.get("/api/health").json()


def test_glossary(vault_app):
    client, root = vault_app
    assert "machine learning" in client.get("/api/glossary").json()["content"]


def test_broken_links(vault_app):
    client, root = vault_app
    assert len(client.get("/api/broken-links").json()) == 0


def test_index_html(vault_app):
    client, root = vault_app
    assert client.get("/").status_code == 200


# --- New endpoint tests ---

def test_layout_roundtrip(vault_app):
    client, root = vault_app
    # Initially empty
    assert client.get("/api/layout").json() == {}
    # Save layout
    layout = {"wiki/concepts/alpha.md": {"x": 100, "y": 200}}
    r = client.put("/api/layout", json=layout)
    assert r.status_code == 200
    # Read back
    assert client.get("/api/layout").json() == layout


def test_page_edit(vault_app):
    client, root = vault_app
    # Read current
    page = client.get("/api/page/wiki/concepts/alpha.md").json()
    fm = page["frontmatter"]
    # Edit content
    r = client.put("/api/page/wiki/concepts/alpha.md", json={
        "frontmatter": fm, "content": "# Alpha\n\nEdited content.\n"
    })
    assert r.status_code == 200
    # Verify
    updated = client.get("/api/page/wiki/concepts/alpha.md").json()
    assert "Edited content" in updated["content"]


def test_page_edit_not_found(vault_app):
    client, root = vault_app
    r = client.put("/api/page/wiki/concepts/missing.md", json={
        "frontmatter": {}, "content": "test"
    })
    assert r.status_code == 404

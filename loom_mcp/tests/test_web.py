"""Tests for the web API server."""

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from loom_mcp.lib.frontmatter import read_frontmatter, write_frontmatter
from loom_mcp.lib.hashing import content_hash
from loom_mcp.lib.registry import save_registry


@pytest.fixture
def loom_app(tmp_path):
    """Create a test loom with sample data and return a TestClient."""
    root = tmp_path / "loom"
    (root / "raw" / "inbox").mkdir(parents=True)
    (root / "wiki" / "pages").mkdir(parents=True)
    (root / "wiki" / "meta").mkdir(parents=True)

    write_frontmatter(
        root / "wiki" / "meta" / "glossary.md",
        {"title": "Glossary", "type": "structure-note", "status": "compiled",
         "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z"},
        "# Glossary\n\n## machine learning\n\nA field of AI.\n",
    )

    save_registry(root / "wiki" / "meta" / "page-registry.json", {
        "pages": [
            {"title": "Alpha", "path": "wiki/pages/alpha.md", "aliases": ["A"]},
            {"title": "Beta", "path": "wiki/pages/beta.md", "aliases": []},
        ]
    })

    src_content = "Raw source for alpha"
    src_hash = content_hash(src_content)
    write_frontmatter(root / "raw" / "inbox" / "src.md", {
        "title": "Source", "captured": "2026-04-04", "content_type": "note",
        "content_hash": src_hash, "compiled": True,
    }, src_content)

    write_frontmatter(root / "wiki" / "pages" / "alpha.md", {
        "title": "Alpha", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": src_hash, "compiler_model": "claude",
        "compiler_prompt_version": "v1", "sources": [{"path": "raw/inbox/src.md", "hash": src_hash}],
        "tags": ["machine-learning"], "related": ["[[beta]]"],
        "aliases": ["A"], "confidence": "high",
    }, "# Alpha\n\nLinks to [[beta]].\n")

    write_frontmatter(root / "wiki" / "pages" / "beta.md", {
        "title": "Beta", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": "xyz", "compiler_model": "claude",
        "compiler_prompt_version": "v1", "sources": [],
        "tags": ["machine-learning"], "related": ["[[alpha]]"],
        "aliases": [], "confidence": "medium",
    }, "# Beta\n\nLinks to [[alpha]].\n")

    import loom_mcp.web as web_module
    original_root = web_module.LOOM_ROOT
    original_layout = web_module.LAYOUT_FILE
    web_module.LOOM_ROOT = root
    web_module.LAYOUT_FILE = root / "wiki" / "meta" / "canvas-layout.json"

    client = TestClient(web_module.app)
    yield client, root

    web_module.LOOM_ROOT = original_root
    web_module.LAYOUT_FILE = original_layout


def test_graph_nodes_and_edges(loom_app):
    client, root = loom_app
    r = client.get("/api/graph")
    assert r.status_code == 200
    data = r.json()
    # New folder-as-page model: nodes include folders + files
    assert len(data["nodes"]) > 0
    assert len(data["edges"]) >= 2  # Alpha↔Beta links
    # Check node structure
    node_labels = {n["data"]["label"] for n in data["nodes"]}
    assert "alpha.md" in node_labels
    assert "beta.md" in node_labels


def test_registry(loom_app):
    client, root = loom_app
    assert len(client.get("/api/registry").json()["pages"]) == 2


def test_page_read(loom_app):
    client, root = loom_app
    r = client.get("/api/page/wiki/pages/alpha.md")
    assert r.status_code == 200
    assert r.json()["frontmatter"]["title"] == "Alpha"


def test_page_not_found(loom_app):
    client, root = loom_app
    assert client.get("/api/page/wiki/pages/missing.md").status_code == 404


def test_tree(loom_app):
    client, root = loom_app
    r = client.get("/api/tree")
    assert r.json()["name"] == "loom"
    folder_names = {c["name"] for c in r.json()["children"] if c["type"] == "folder"}
    assert "wiki" in folder_names


def test_tree_structure_for_files_view(loom_app):
    """Tree data has all fields needed by the Files view (tree + tile modes)."""
    client, root = loom_app
    tree = client.get("/api/tree").json()

    # Root node
    assert tree["type"] == "folder"
    assert "children" in tree

    def check_node(node, depth=0):
        assert "id" in node
        assert "name" in node
        assert "type" in node
        assert node["type"] in ("folder", "file")
        if node["type"] == "folder":
            assert "children" in node
            assert isinstance(node["children"], list)
            for child in node["children"]:
                check_node(child, depth + 1)

    for child in tree["children"]:
        check_node(child)

    # Verify we can navigate into wiki folder
    wiki = next((c for c in tree["children"] if c["name"] == "wiki"), None)
    assert wiki is not None
    assert wiki["type"] == "folder"
    assert len(wiki["children"]) > 0


def test_health(loom_app):
    client, root = loom_app
    assert "total_issues" in client.get("/api/health").json()


def test_glossary(loom_app):
    client, root = loom_app
    assert "machine learning" in client.get("/api/glossary").json()["content"]


def test_broken_links(loom_app):
    client, root = loom_app
    assert len(client.get("/api/broken-links").json()) == 0


def test_index_html(loom_app):
    client, root = loom_app
    assert client.get("/").status_code == 200


# --- New endpoint tests ---

def test_layout_roundtrip(loom_app):
    client, root = loom_app
    # Initially empty
    assert client.get("/api/layout").json() == {}
    # Save layout
    layout = {"wiki/pages/alpha.md": {"x": 100, "y": 200}}
    r = client.put("/api/layout", json=layout)
    assert r.status_code == 200
    # Read back
    assert client.get("/api/layout").json() == layout


def test_page_edit(loom_app):
    client, root = loom_app
    # Read current
    page = client.get("/api/page/wiki/pages/alpha.md").json()
    fm = page["frontmatter"]
    # Edit content
    r = client.put("/api/page/wiki/pages/alpha.md", json={
        "frontmatter": fm, "content": "# Alpha\n\nEdited content.\n"
    })
    assert r.status_code == 200
    # Verify
    updated = client.get("/api/page/wiki/pages/alpha.md").json()
    assert "Edited content" in updated["content"]


def test_page_edit_not_found(loom_app):
    client, root = loom_app
    r = client.put("/api/page/wiki/pages/missing.md", json={
        "frontmatter": {}, "content": "test"
    })
    assert r.status_code == 404

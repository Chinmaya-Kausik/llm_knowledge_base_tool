"""Tests for sub-document/nesting support in the graph builder."""

import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from vault_mcp.lib.frontmatter import write_frontmatter
from vault_mcp.lib.hashing import content_hash
from vault_mcp.lib.registry import save_registry


@pytest.fixture
def vault_with_nesting(tmp_path):
    """Create a vault with parent-child page relationships."""
    root = tmp_path / "vault"
    (root / "wiki" / "concepts").mkdir(parents=True)
    (root / "wiki" / "meta").mkdir(parents=True)

    save_registry(root / "wiki" / "meta" / "page-registry.json", {
        "pages": [
            {"title": "Transformers", "path": "wiki/concepts/transformers.md", "aliases": []},
            {"title": "Self-Attention", "path": "wiki/concepts/self-attention.md", "aliases": []},
            {"title": "Multi-Head Attention", "path": "wiki/concepts/multi-head.md", "aliases": []},
        ]
    })

    write_frontmatter(
        root / "wiki" / "meta" / "glossary.md",
        {"title": "Glossary", "type": "structure-note", "status": "compiled",
         "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z"},
        "# Glossary\n",
    )

    # Parent page (no parent field)
    write_frontmatter(root / "wiki" / "concepts" / "transformers.md", {
        "title": "Transformers", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": "a", "compiler_model": "claude", "compiler_prompt_version": "v1",
        "sources": [], "tags": [], "related": ["[[Self-Attention]]"],
        "aliases": [], "confidence": "high",
    }, "# Transformers\n\nUses [[Self-Attention]].\n")

    # Child page (has parent field)
    write_frontmatter(root / "wiki" / "concepts" / "self-attention.md", {
        "title": "Self-Attention", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": "b", "compiler_model": "claude", "compiler_prompt_version": "v1",
        "sources": [], "tags": [], "related": [],
        "aliases": [], "confidence": "high",
        "parent": "[[Transformers]]",
    }, "# Self-Attention\n\nA mechanism in [[Transformers]].\n")

    # Grandchild page
    write_frontmatter(root / "wiki" / "concepts" / "multi-head.md", {
        "title": "Multi-Head Attention", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": "c", "compiler_model": "claude", "compiler_prompt_version": "v1",
        "sources": [], "tags": [], "related": [],
        "aliases": [], "confidence": "medium",
        "parent": "[[Self-Attention]]",
    }, "# Multi-Head Attention\n\nRuns [[Self-Attention]] in parallel.\n")

    import vault_mcp.web as web_module
    original_root = web_module.VAULT_ROOT
    original_layout = web_module.LAYOUT_FILE
    web_module.VAULT_ROOT = root
    web_module.LAYOUT_FILE = root / "wiki" / "meta" / "canvas-layout.json"

    client = TestClient(web_module.app)
    yield client, root

    web_module.VAULT_ROOT = original_root
    web_module.LAYOUT_FILE = original_layout


def test_graph_parent_field(vault_with_nesting):
    client, root = vault_with_nesting
    r = client.get("/api/graph")
    data = r.json()

    nodes_by_label = {n["data"]["label"]: n["data"] for n in data["nodes"]}

    # Transformers has no parent
    assert nodes_by_label["Transformers"]["parent"] is None

    # Self-Attention is child of Transformers
    assert nodes_by_label["Self-Attention"]["parent"] == "wiki/concepts/transformers.md"

    # Multi-Head is child of Self-Attention
    assert nodes_by_label["Multi-Head Attention"]["parent"] == "wiki/concepts/self-attention.md"


def test_graph_children_field(vault_with_nesting):
    client, root = vault_with_nesting
    r = client.get("/api/graph")
    data = r.json()

    nodes_by_label = {n["data"]["label"]: n["data"] for n in data["nodes"]}

    # Transformers has Self-Attention as child
    assert "wiki/concepts/self-attention.md" in nodes_by_label["Transformers"]["children"]

    # Self-Attention has Multi-Head as child
    assert "wiki/concepts/multi-head.md" in nodes_by_label["Self-Attention"]["children"]

    # Multi-Head has no children
    assert nodes_by_label["Multi-Head Attention"]["children"] == []


def test_graph_edges_still_work(vault_with_nesting):
    client, root = vault_with_nesting
    r = client.get("/api/graph")
    data = r.json()

    # Edges should connect pages via wiki-links regardless of nesting
    edge_pairs = {(e["data"]["source"], e["data"]["target"]) for e in data["edges"]}
    assert ("wiki/concepts/transformers.md", "wiki/concepts/self-attention.md") in edge_pairs
    assert ("wiki/concepts/self-attention.md", "wiki/concepts/transformers.md") in edge_pairs
    assert ("wiki/concepts/multi-head.md", "wiki/concepts/self-attention.md") in edge_pairs


def test_top_nodes_excludes_children(vault_with_nesting):
    client, root = vault_with_nesting
    r = client.get("/api/graph")
    data = r.json()

    top_labels = {n["data"]["label"] for n in data["top_nodes"]}
    # Transformers is top-level (no parent)
    assert "Transformers" in top_labels
    # Self-Attention and Multi-Head are children — should NOT be in top_nodes
    assert "Self-Attention" not in top_labels
    assert "Multi-Head Attention" not in top_labels


def test_top_edges_aggregated(vault_with_nesting):
    client, root = vault_with_nesting
    r = client.get("/api/graph")
    data = r.json()

    top_edge_pairs = {(e["data"]["source"], e["data"]["target"]) for e in data["top_edges"]}

    # Self-Attention links to Transformers, but both are in same hierarchy
    # (Self-Attention is child of Transformers), so NO top-level edge between them
    assert ("wiki/concepts/transformers.md", "wiki/concepts/transformers.md") not in top_edge_pairs

    # Multi-Head links to Self-Attention — both under Transformers hierarchy, so internal → no top edge
    # (Multi-Head is grandchild of Transformers via Self-Attention)


def test_top_edges_cross_hierarchy(vault_with_nesting):
    """Edges between different top-level hierarchies should appear in top_edges."""
    client, root = vault_with_nesting

    # Add a standalone page that links to Multi-Head (a grandchild of Transformers)
    write_frontmatter(root / "wiki" / "concepts" / "standalone.md", {
        "title": "Standalone", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "source_hash": "x", "compiler_model": "claude", "compiler_prompt_version": "v1",
        "sources": [], "tags": [], "related": [],
        "aliases": [], "confidence": "high",
    }, "# Standalone\n\nReferences [[Multi-Head Attention]].\n")

    import json
    reg_path = root / "wiki" / "meta" / "page-registry.json"
    reg = json.loads(reg_path.read_text())
    reg["pages"].append({"title": "Standalone", "path": "wiki/concepts/standalone.md", "aliases": []})
    reg_path.write_text(json.dumps(reg))

    r = client.get("/api/graph")
    data = r.json()

    top_edge_pairs = {(e["data"]["source"], e["data"]["target"]) for e in data["top_edges"]}

    # Standalone → Multi-Head should aggregate to Standalone → Transformers (top ancestor of Multi-Head)
    assert ("wiki/concepts/standalone.md", "wiki/concepts/transformers.md") in top_edge_pairs

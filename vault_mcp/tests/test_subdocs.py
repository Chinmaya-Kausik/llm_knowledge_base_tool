"""Tests for sub-document/nesting in the folder-as-page model."""

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from vault_mcp.lib.frontmatter import write_frontmatter


@pytest.fixture
def vault_with_nesting(tmp_path):
    """Create a vault with folder-based page hierarchy."""
    root = tmp_path / "vault"
    root.mkdir()

    # Create folder structure with READMEs
    wiki = root / "wiki"
    wiki.mkdir()
    write_frontmatter(wiki / "README.md", {"title": "Knowledge Base"}, "# Wiki\n")

    concepts = wiki / "concepts"
    concepts.mkdir()

    # Transformers folder-page
    transformers = concepts / "transformers"
    transformers.mkdir()
    write_frontmatter(transformers / "README.md", {
        "title": "Transformers", "type": "concept",
    }, "# Transformers\n\nUses [[Self-Attention]].\n")

    # Self-Attention subfolder inside transformers (child page)
    sa = transformers / "self-attention"
    sa.mkdir()
    write_frontmatter(sa / "README.md", {
        "title": "Self-Attention", "type": "concept",
    }, "# Self-Attention\n\nPart of [[Transformers]].\n")

    # Multi-Head inside self-attention (grandchild)
    mh = sa / "multi-head"
    mh.mkdir()
    write_frontmatter(mh / "README.md", {
        "title": "Multi-Head Attention", "type": "concept",
    }, "# Multi-Head\n\nRuns [[Self-Attention]] in parallel.\n")

    # Glossary and meta for compatibility
    meta = wiki / "meta"
    meta.mkdir()
    (meta / "page-registry.json").write_text('{"pages": []}')
    write_frontmatter(meta / "glossary.md", {
        "title": "Glossary", "type": "structure-note",
    }, "# Glossary\n")

    import vault_mcp.web as web_module
    original_root = web_module.VAULT_ROOT
    original_layout = web_module.LAYOUT_FILE
    web_module.VAULT_ROOT = root
    web_module.LAYOUT_FILE = root / "wiki" / "meta" / "canvas-layout.json"

    client = TestClient(web_module.app)
    yield client, root

    web_module.VAULT_ROOT = original_root
    web_module.LAYOUT_FILE = original_layout


def test_graph_has_folder_pages(vault_with_nesting):
    client, root = vault_with_nesting
    data = client.get("/api/graph").json()
    labels = {n["data"]["label"] for n in data["nodes"]}
    assert "Transformers" in labels
    assert "Self-Attention" in labels
    assert "Multi-Head Attention" in labels


def test_graph_parent_child(vault_with_nesting):
    client, root = vault_with_nesting
    data = client.get("/api/graph").json()
    node_map = {n["data"]["label"]: n["data"] for n in data["nodes"]}

    # Self-Attention is inside transformers folder
    sa = node_map["Self-Attention"]
    assert "transformers" in sa["parent_id"]

    # Multi-Head is inside self-attention folder
    mh = node_map["Multi-Head Attention"]
    assert "self-attention" in mh["parent_id"]


def test_top_nodes(vault_with_nesting):
    client, root = vault_with_nesting
    data = client.get("/api/graph").json()
    top_labels = {n["data"]["label"] for n in data["top_nodes"]}
    # Top level should be wiki/ (and maybe README.md)
    assert "Knowledge Base" in top_labels
    # Transformers is nested inside wiki/concepts/, not top-level
    assert "Transformers" not in top_labels


def test_edges_from_wiki_links(vault_with_nesting):
    client, root = vault_with_nesting
    data = client.get("/api/graph").json()
    edge_pairs = {(e["data"]["source"], e["data"]["target"]) for e in data["edges"]}
    # Transformers README links to Self-Attention
    has_t_to_sa = any("transformers" in s and "self-attention" in t for s, t in edge_pairs)
    assert has_t_to_sa


def test_top_edges_aggregated(vault_with_nesting):
    client, root = vault_with_nesting

    # Add a standalone page outside wiki that links to a nested page
    projects = root / "projects"
    projects.mkdir()
    write_frontmatter(projects / "README.md", {"title": "Projects"}, "# Projects\n\nSee [[Self-Attention]].\n")

    data = client.get("/api/graph").json()
    top_edge_pairs = {(e["data"]["source"], e["data"]["target"]) for e in data["top_edges"]}
    # Projects → Self-Attention aggregates to projects → wiki
    has_cross = any("projects" in s and "wiki" in t for s, t in top_edge_pairs)
    assert has_cross

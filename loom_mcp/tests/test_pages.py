"""Tests for folder-as-page abstraction."""

import tempfile
from pathlib import Path

from loom_mcp.lib.frontmatter import write_frontmatter
from loom_mcp.lib.pages import (
    build_page_graph,
    get_filetype_category,
    get_page_content,
    get_page_title,
    is_hidden,
    resolve_wiki_link,
    walk_pages,
)


def _make_loom(tmp: str) -> Path:
    """Create a test loom with folder-as-page structure."""
    root = Path(tmp) / "loom"
    root.mkdir()

    # Root README
    write_frontmatter(root / "README.md", {"title": "My Loom"}, "# My Loom\n\nOverview of everything.\n")

    # Wiki folder with subpages
    wiki = root / "wiki"
    wiki.mkdir()
    write_frontmatter(wiki / "README.md", {"title": "Knowledge Base"}, "# Knowledge Base\n\nStandalone articles.\n")

    attn = wiki / "attention"
    attn.mkdir()
    write_frontmatter(attn / "README.md", {
        "title": "Attention Mechanisms", "type": "concept", "tags": ["ml"],
        "related": ["[[transformers-app]]"],
    }, "# Attention Mechanisms\n\nCore concept. See [[transformers-app]].\n")

    # Project folder
    proj = root / "projects"
    proj.mkdir()
    write_frontmatter(proj / "README.md", {"title": "Projects"}, "# Projects\n\nActive work.\n")

    app = proj / "transformers-app"
    app.mkdir()
    write_frontmatter(app / "README.md", {
        "title": "Transformers Project", "type": "project", "tags": ["ml", "code"],
    }, "# Transformers Project\n\nUses [[attention]].\n")

    # Code file inside project
    (app / "main.py").write_text("# Main entry point\ndef train(): pass\n")

    # Hidden dir
    (root / "__pycache__").mkdir()
    (root / "__pycache__" / "foo.pyc").write_text("bytecode")

    (root / ".git").mkdir()

    return root


# --- is_hidden ---

def test_hidden_pycache():
    assert is_hidden(Path("__pycache__"))

def test_hidden_dotfile():
    assert is_hidden(Path(".gitignore"))

def test_hidden_pyc():
    assert is_hidden(Path("foo.pyc"))

def test_not_hidden_normal():
    assert not is_hidden(Path("main.py"))
    assert not is_hidden(Path("wiki"))


# --- get_filetype_category ---

def test_filetype_code():
    assert get_filetype_category(Path("main.py")) == "code"
    assert get_filetype_category(Path("app.ts")) == "code"

def test_filetype_papers():
    assert get_filetype_category(Path("draft.tex")) == "papers"
    assert get_filetype_category(Path("paper.pdf")) == "papers"

def test_filetype_data():
    assert get_filetype_category(Path("config.yaml")) == "data"
    assert get_filetype_category(Path("data.csv")) == "data"

def test_filetype_markdown():
    assert get_filetype_category(Path("notes.md")) == "markdown"

def test_filetype_misc():
    assert get_filetype_category(Path("photo.png")) == "misc"


# --- get_page_title ---

def test_page_title_folder_with_readme():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        title = get_page_title(loom / "wiki" / "attention", loom)
        assert title == "attention"

def test_page_title_folder_without_readme():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        (loom / "empty-folder").mkdir()
        title = get_page_title(loom / "empty-folder", loom)
        assert title == "empty-folder"

def test_page_title_file():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        title = get_page_title(loom / "projects" / "transformers-app" / "main.py", loom)
        assert title == "main.py"


# --- get_page_content ---

def test_page_content_folder():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        content = get_page_content(loom / "wiki" / "attention")
        assert "Attention" in content

def test_page_content_file():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        content = get_page_content(loom / "projects" / "transformers-app" / "main.py")
        assert "def train" in content


def test_page_content_md_file_strips_frontmatter():
    """Markdown files with frontmatter should return only the content body, not the YAML."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        # The attention README has frontmatter — content should NOT include ---
        content = get_page_content(loom / "wiki" / "attention" / "README.md")
        assert "---" not in content
        assert "Attention" in content


def test_page_content_folder_strips_frontmatter():
    """Folder content (from README) should not include frontmatter."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        content = get_page_content(loom / "wiki" / "attention")
        assert "---" not in content
        assert "Attention" in content


def test_page_content_md_standalone():
    """Standalone .md file with frontmatter returns content body only."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        # Create a standalone md file with frontmatter
        write_frontmatter(loom / "wiki" / "standalone.md", {
            "title": "Standalone", "type": "concept",
        }, "# Standalone Page\n\nThis is the body.\n")
        content = get_page_content(loom / "wiki" / "standalone.md")
        assert "# Standalone Page" in content
        assert "This is the body" in content
        assert "---" not in content
        assert "title:" not in content


# --- walk_pages ---

def test_walk_excludes_hidden():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        pages = walk_pages(loom)
        ids = {p["id"] for p in pages}
        assert "__pycache__" not in ids
        assert ".git" not in ids

def test_walk_includes_folders_and_files():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        pages = walk_pages(loom)
        ids = {p["id"] for p in pages}
        assert "wiki" in ids
        assert "wiki/attention" in ids
        assert "projects/transformers-app/main.py" in ids

def test_walk_parent_child_relationship():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        pages = walk_pages(loom)
        page_map = {p["id"]: p for p in pages}

        # attention is child of wiki
        assert page_map["wiki/attention"]["parent_id"] == "wiki"
        # wiki lists attention as child
        assert "wiki/attention" in page_map["wiki"]["children_ids"]

def test_walk_page_metadata():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        pages = walk_pages(loom)
        page_map = {p["id"]: p for p in pages}

        attn = page_map["wiki/attention"]
        assert attn["type"] == "concept"
        assert attn["tags"] == ["ml"]
        assert attn["has_readme"] is True

        main_py = page_map["projects/transformers-app/main.py"]
        assert main_py["category"] == "code"
        assert main_py["is_folder"] is False


# --- resolve_wiki_link ---

def test_resolve_by_name():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        pages = walk_pages(loom)
        result = resolve_wiki_link("attention", pages)
        assert result == "wiki/attention"

def test_resolve_by_folder_name():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        pages = walk_pages(loom)
        result = resolve_wiki_link("attention", pages)
        assert result == "wiki/attention"

def test_resolve_case_insensitive():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        pages = walk_pages(loom)
        result = resolve_wiki_link("Attention", pages)
        assert result == "wiki/attention"

def test_resolve_not_found():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        pages = walk_pages(loom)
        assert resolve_wiki_link("Nonexistent", pages) is None


# --- build_page_graph ---

def test_graph_has_edges():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        graph = build_page_graph(loom)
        # Attention → Transformers Project and vice versa
        edge_pairs = {(e["source"], e["target"]) for e in graph["edges"]}
        assert ("wiki/attention", "projects/transformers-app") in edge_pairs
        assert ("projects/transformers-app", "wiki/attention") in edge_pairs

def test_graph_top_pages():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        graph = build_page_graph(loom)
        top_ids = {p["id"] for p in graph["top_pages"]}
        # Top-level: README.md, wiki/, projects/
        assert "wiki" in top_ids
        assert "projects" in top_ids

def test_graph_top_edges_aggregated():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        graph = build_page_graph(loom)
        top_edge_pairs = {(e["source"], e["target"]) for e in graph["top_edges"]}
        # wiki/attention → projects/transformers-app aggregates to wiki → projects
        assert ("wiki", "projects") in top_edge_pairs

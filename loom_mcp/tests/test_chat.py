"""Tests for chat backend — context injection and prompt building."""

import tempfile
from pathlib import Path

from loom_mcp.lib.frontmatter import write_frontmatter
from loom_mcp.chat import build_prompt, build_system_prompt, sessions


def _make_loom(tmp: str) -> Path:
    root = Path(tmp) / "loom"
    root.mkdir()

    # Wiki with master index
    wiki = root / "wiki"
    (wiki / "meta").mkdir(parents=True)
    write_frontmatter(wiki / "meta" / "index.md", {
        "title": "Master Index", "type": "structure-note",
    }, "# Master Index\n\n- **Attention** — core ML concept\n- **My App** — project\n")
    (wiki / "meta" / "page-registry.json").write_text('{"pages": []}')

    # A folder page
    attn = wiki / "attention"
    attn.mkdir()
    write_frontmatter(attn / "README.md", {
        "title": "Attention Mechanisms",
    }, "# Attention\n\nSelf-attention is a key mechanism.\n\n## Children\n- query.py — query computation\n")

    # A code file
    (attn / "query.py").write_text("def compute_query(x):\n    return x @ W_q\n")

    # Project folder
    proj = root / "projects" / "my-app"
    proj.mkdir(parents=True)
    write_frontmatter(proj / "README.md", {"title": "My App"}, "# My App\n\nA project.\n")

    return root


# --- build_prompt ---

def test_build_prompt_simple():
    prompt = build_prompt("What is attention?", {}, "s1", Path("/tmp"))
    assert "What is attention?" in prompt


def test_build_prompt_with_selection():
    prompt = build_prompt("Explain this", {
        "selection": "return x @ W_q",
        "selection_file": "wiki/attention/query.py",
    }, "s1", Path("/tmp"))
    assert "return x @ W_q" in prompt
    assert "wiki/attention/query.py" in prompt
    assert "Explain this" in prompt


def test_build_prompt_no_selection():
    prompt = build_prompt("Hello", {"selection": None}, "s1", Path("/tmp"))
    assert prompt == "Hello"


# --- build_system_prompt ---

def test_system_prompt_page_level():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        sessions["test-page"] = {"page_path": "wiki/attention/query.py"}
        prompt = build_system_prompt("test-page", loom, "page")
        # Should include the file content
        assert "compute_query" in prompt
        # Should include parent README
        assert "Attention" in prompt


def test_system_prompt_folder_level():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        sessions["test-folder"] = {"page_path": "wiki/attention"}
        prompt = build_system_prompt("test-folder", loom, "folder")
        # Should include folder README
        assert "Self-attention" in prompt or "Attention" in prompt


def test_system_prompt_global_level():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        sessions["test-global"] = {"page_path": "wiki/attention"}
        prompt = build_system_prompt("test-global", loom, "global")
        # Should include master index
        assert "Master Index" in prompt
        assert "Attention" in prompt
        assert "My App" in prompt


def test_system_prompt_no_session():
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        prompt = build_system_prompt("nonexistent", loom, "page")
        # Should still return base prompt
        assert "knowledge base" in prompt.lower()


def test_system_prompt_global_without_index():
    with tempfile.TemporaryDirectory() as tmp:
        loom = Path(tmp) / "empty"
        loom.mkdir()
        sessions["test-empty"] = {}
        prompt = build_system_prompt("test-empty", loom, "global")
        assert "knowledge base" in prompt.lower()

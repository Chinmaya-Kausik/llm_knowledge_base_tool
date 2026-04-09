"""Tests for chat backend — context injection and prompt building."""

import tempfile
from pathlib import Path

from loom_mcp.lib.frontmatter import write_frontmatter
from loom_mcp.chat import (
    build_prompt, build_system_prompt, sessions,
    _permissions_block, _memory_block, _location_block, _load_context_config,
)


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
    write_frontmatter(attn / "ABOUT.md", {
        "title": "Attention Mechanisms",
    }, "# Attention\n\nSelf-attention is a key mechanism.\n\n## Children\n- query.py — query computation\n")

    # A code file
    (attn / "query.py").write_text("def compute_query(x):\n    return x @ W_q\n")

    # Project folder
    proj = root / "projects" / "my-app"
    proj.mkdir(parents=True)
    write_frontmatter(proj / "ABOUT.md", {"title": "My App"}, "# My App\n\nA project.\n")

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


# --- modular blocks ---

def test_permissions_block_with_claudemd():
    """When CLAUDE.md exists, permissions block is just permissions."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = Path(tmp)
        (loom / "CLAUDE.md").write_text("# Loom\nTest content.\n")
        perm = _permissions_block(loom)
        assert "NEVER" in perm
        # Should NOT include default conventions (CLAUDE.md handles that)
        assert "unified knowledge base" not in perm


def test_permissions_block_fallback():
    """When CLAUDE.md is missing, permissions block includes conventions."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = Path(tmp)
        perm = _permissions_block(loom)
        assert "NEVER" in perm
        # Should include default conventions as fallback
        assert "unified knowledge base" in perm.lower()


def test_memory_block_project():
    """Memory block reads project MEMORY.md when in a project."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        proj = loom / "projects" / "my-app"
        (proj / "MEMORY.md").write_text("- uses-typescript — strict mode enabled\n")
        config = {"memory": {"enabled": True, "max_chars": 2000}}
        result = _memory_block(loom, "projects/my-app/src/foo.py", config)
        assert result is not None
        assert "uses-typescript" in result


def test_memory_block_root():
    """Memory block reads root MEMORY.md when not in a project."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        (loom / "MEMORY.md").write_text("- prefers-concise — terse responses\n")
        config = {"memory": {"enabled": True, "max_chars": 2000}}
        result = _memory_block(loom, "wiki/attention/query.py", config)
        assert result is not None
        assert "prefers-concise" in result


def test_memory_block_disabled():
    """Memory block returns None when disabled."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        (loom / "MEMORY.md").write_text("- something\n")
        config = {"memory": {"enabled": False}}
        result = _memory_block(loom, None, config)
        assert result is None


def test_memory_block_truncation():
    """Memory block truncates at max_chars."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        (loom / "MEMORY.md").write_text("x" * 5000)
        config = {"memory": {"enabled": True, "max_chars": 100}}
        result = _memory_block(loom, "wiki/something", config)
        assert result is not None
        assert "more memories available" in result
        assert len(result) < 200  # header + truncated content


def test_memory_block_no_memory():
    """Memory block returns None when no MEMORY.md exists."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        config = {"memory": {"enabled": True, "max_chars": 2000}}
        result = _memory_block(loom, "wiki/something", config)
        assert result is None


def test_location_block_page():
    """Location block injects page content + parent README."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        config = {"page_content": {"enabled": True, "max_chars": 8000}, "folder_readme": {"enabled": True}}
        result = _location_block(loom, "wiki/attention/query.py", "page", config)
        assert result is not None
        assert "compute_query" in result
        assert "Attention" in result


def test_location_block_page_disabled():
    """Location block respects page_content.enabled."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        config = {"page_content": {"enabled": False}, "folder_readme": {"enabled": True}}
        result = _location_block(loom, "wiki/attention/query.py", "page", config)
        # No page content, but folder README might still appear
        assert result is None or "compute_query" not in result


def test_config_defaults():
    """Config returns defaults when no config.yaml exists."""
    with tempfile.TemporaryDirectory() as tmp:
        config = _load_context_config(Path(tmp))
        assert config["memory"]["enabled"] is True
        assert config["memory"]["max_chars"] == 2000
        assert config["page_content"]["max_chars"] == 8000


def test_config_from_file():
    """Config reads from loom-local config.yaml."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = Path(tmp)
        (loom / "config.yaml").write_text("context:\n  memory:\n    max_chars: 500\n")
        config = _load_context_config(loom)
        assert config["memory"]["max_chars"] == 500
        # Defaults preserved for unset values
        assert config["memory"]["enabled"] is True


def test_system_prompt_has_dynamic_boundary():
    """System prompt always includes the caching boundary marker."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        sessions["test-boundary"] = {"page_path": "wiki/attention/query.py"}
        prompt = build_system_prompt("test-boundary", loom, "page")
        assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" in prompt


def test_system_prompt_preset_format():
    """Build system prompt returns a string suitable for preset append."""
    with tempfile.TemporaryDirectory() as tmp:
        loom = _make_loom(tmp)
        sessions["test-preset"] = {}
        prompt = build_system_prompt("test-preset", loom, "page")
        # Should be a string (the append value for preset format)
        assert isinstance(prompt, str)
        assert len(prompt) > 0

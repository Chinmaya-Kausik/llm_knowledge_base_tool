"""Comprehensive tests for the chat system — backend, context injection, WebSocket protocol."""

import asyncio
import json
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from vault_mcp.lib.frontmatter import write_frontmatter
from vault_mcp.chat import (
    build_prompt,
    build_system_prompt,
    sessions,
    ws_chat,
)


def _make_vault(tmp: str) -> Path:
    """Create a test vault with varied content."""
    root = Path(tmp) / "vault"
    root.mkdir()

    # Wiki with articles
    wiki = root / "wiki"
    (wiki / "meta").mkdir(parents=True)
    (wiki / "meta" / "page-registry.json").write_text('{"pages": []}')

    # Master index
    write_frontmatter(wiki / "meta" / "index.md", {
        "title": "Master Index", "type": "structure-note",
    }, "# Master Index\n\n- **Attention** — core ML concept\n- **BERT** — language model\n- **My App** — project\n")

    # A concept folder
    attn = wiki / "concepts" / "attention"
    attn.mkdir(parents=True)
    write_frontmatter(attn / "README.md", {
        "title": "Attention Mechanisms", "type": "concept",
    }, "# Attention\n\nSelf-attention is key. See [[BERT]].\n\n## Children\n- query.py\n")

    # A file inside the concept
    (attn / "query.py").write_text("def compute_query(x):\n    return x @ W_q\n")

    # A standalone markdown file
    bert = wiki / "concepts" / "bert"
    bert.mkdir(parents=True)
    write_frontmatter(bert / "README.md", {
        "title": "BERT", "type": "concept",
    }, "# BERT\n\nBidirectional model. Uses [[Attention Mechanisms]].\n")

    # A project
    proj = root / "projects" / "my-app"
    proj.mkdir(parents=True)
    write_frontmatter(proj / "README.md", {
        "title": "My App", "type": "project",
    }, "# My App\n\nUses [[Attention Mechanisms]] internally.\n")
    (proj / "main.py").write_text("from attention import SelfAttention\n")

    return root


# ============================================================
# build_prompt tests
# ============================================================

class TestBuildPrompt:
    def test_simple_message(self):
        prompt = build_prompt("What is attention?", {}, "s1", Path("/tmp"))
        assert "What is attention?" in prompt

    def test_with_selection_context(self):
        prompt = build_prompt("Explain this", {
            "selection": "return x @ W_q",
            "selection_file": "wiki/concepts/attention/query.py",
        }, "s1", Path("/tmp"))
        assert "return x @ W_q" in prompt
        assert "wiki/concepts/attention/query.py" in prompt
        assert "Explain this" in prompt

    def test_selection_none_ignored(self):
        prompt = build_prompt("Hello", {"selection": None, "selection_file": None}, "s1", Path("/tmp"))
        assert prompt == "Hello"

    def test_empty_selection_ignored(self):
        prompt = build_prompt("Hello", {"selection": "", "selection_file": "foo.py"}, "s1", Path("/tmp"))
        assert prompt == "Hello"

    def test_selection_without_file(self):
        prompt = build_prompt("Why?", {"selection": "some text", "selection_file": ""}, "s1", Path("/tmp"))
        # Should still include selection even without file
        assert "some text" in prompt


# ============================================================
# build_system_prompt tests
# ============================================================

class TestBuildSystemPrompt:
    def test_page_level_with_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            sessions["test-page-file"] = {"page_path": "wiki/concepts/attention/query.py"}
            prompt = build_system_prompt("test-page-file", vault, "page")
            assert "compute_query" in prompt
            # Should also include parent README
            assert "Attention" in prompt

    def test_page_level_with_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            sessions["test-page-folder"] = {"page_path": "wiki/concepts/attention"}
            prompt = build_system_prompt("test-page-folder", vault, "page")
            assert "Attention" in prompt

    def test_page_level_with_project_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            sessions["test-proj-file"] = {"page_path": "projects/my-app/main.py"}
            prompt = build_system_prompt("test-proj-file", vault, "page")
            assert "SelfAttention" in prompt
            # Parent README
            assert "My App" in prompt

    def test_folder_level(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            sessions["test-folder"] = {"page_path": "wiki/concepts/attention"}
            prompt = build_system_prompt("test-folder", vault, "folder")
            assert "Attention" in prompt
            assert "browsing folder" in prompt.lower()

    def test_folder_level_from_file_path(self):
        """When page_path is a file, folder level should use its parent."""
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            sessions["test-folder-file"] = {"page_path": "wiki/concepts/attention/query.py"}
            prompt = build_system_prompt("test-folder-file", vault, "folder")
            # Should show the attention folder README, not the py file
            assert "Attention" in prompt

    def test_global_level(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            sessions["test-global"] = {"page_path": "wiki/concepts/attention"}
            prompt = build_system_prompt("test-global", vault, "global")
            assert "Master Index" in prompt
            assert "Attention" in prompt
            assert "BERT" in prompt
            assert "My App" in prompt

    def test_global_without_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "empty"
            vault.mkdir()
            sessions["test-no-index"] = {}
            prompt = build_system_prompt("test-no-index", vault, "global")
            assert "knowledge base" in prompt.lower()

    def test_no_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            prompt = build_system_prompt("nonexistent-session", vault, "page")
            assert "knowledge base" in prompt.lower()

    def test_page_level_no_page_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            sessions["test-no-path"] = {"page_path": None}
            prompt = build_system_prompt("test-no-path", vault, "page")
            assert "knowledge base" in prompt.lower()

    def test_page_level_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            sessions["test-missing"] = {"page_path": "nonexistent/path.md"}
            prompt = build_system_prompt("test-missing", vault, "page")
            # Should not crash, just return base prompt
            assert "knowledge base" in prompt.lower()

    def test_context_level_invalid_defaults_gracefully(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            sessions["test-invalid"] = {"page_path": "wiki/concepts/attention"}
            prompt = build_system_prompt("test-invalid", vault, "invalid_level")
            assert "knowledge base" in prompt.lower()


# ============================================================
# Session management tests
# ============================================================

class TestSessionManagement:
    def test_session_stores_page_path(self):
        sessions.clear()
        sessions["s1"] = {"page_path": "wiki/concepts/attention"}
        assert sessions["s1"]["page_path"] == "wiki/concepts/attention"

    def test_session_page_path_update(self):
        sessions["s2"] = {"page_path": "old/path"}
        sessions["s2"]["page_path"] = "new/path"
        assert sessions["s2"]["page_path"] == "new/path"

    def test_session_has_run_flag(self):
        sessions["s3"] = {}
        assert sessions["s3"].get("has_run") is None
        sessions["s3"]["has_run"] = True
        assert sessions["s3"]["has_run"] is True


# ============================================================
# WebSocket protocol tests (unit level, no actual claude subprocess)
# ============================================================

class TestWebSocketProtocol:
    def test_websocket_endpoint_exists(self):
        """Verify the /ws/chat endpoint is registered."""
        import vault_mcp.web as web_module
        original_root = web_module.VAULT_ROOT

        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            web_module.VAULT_ROOT = vault
            web_module.LAYOUT_FILE = vault / "wiki" / "meta" / "canvas-layout.json"

            client = TestClient(web_module.app)
            # WebSocket endpoints return 403 on GET (not 404)
            # This confirms the endpoint exists
            routes = [r.path for r in web_module.app.routes]
            assert "/ws/chat" in routes

            web_module.VAULT_ROOT = original_root

    def test_settings_endpoint_returns_auth_status(self):
        """The settings endpoint should include claude auth info."""
        import vault_mcp.web as web_module
        original_root = web_module.VAULT_ROOT

        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            web_module.VAULT_ROOT = vault
            web_module.LAYOUT_FILE = vault / "wiki" / "meta" / "canvas-layout.json"

            client = TestClient(web_module.app)
            r = client.get("/api/settings")
            data = r.json()
            assert "vault_root" in data
            assert "claude_authenticated" in data

            web_module.VAULT_ROOT = original_root


# ============================================================
# Context injection edge cases
# ============================================================

class TestContextEdgeCases:
    def test_very_long_file_content(self):
        """Large files shouldn't crash the system prompt builder."""
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            # Create a huge file
            huge = vault / "huge.py"
            huge.write_text("x = 1\n" * 100000)  # ~600KB
            sessions["test-huge"] = {"page_path": "huge.py"}
            prompt = build_system_prompt("test-huge", vault, "page")
            assert len(prompt) > 1000  # It includes content
            assert "x = 1" in prompt

    def test_binary_file_doesnt_crash(self):
        """Binary files should be handled gracefully."""
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            (vault / "image.png").write_bytes(b'\x89PNG\r\n\x1a\n' + b'\x00' * 100)
            sessions["test-binary"] = {"page_path": "image.png"}
            prompt = build_system_prompt("test-binary", vault, "page")
            # Should not crash, content might be empty
            assert "knowledge base" in prompt.lower()

    def test_deeply_nested_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = _make_vault(tmp)
            deep = vault / "a" / "b" / "c" / "d"
            deep.mkdir(parents=True)
            write_frontmatter(deep / "README.md", {"title": "Deep"}, "# Deep page\n")
            sessions["test-deep"] = {"page_path": "a/b/c/d"}
            prompt = build_system_prompt("test-deep", vault, "page")
            assert "Deep" in prompt

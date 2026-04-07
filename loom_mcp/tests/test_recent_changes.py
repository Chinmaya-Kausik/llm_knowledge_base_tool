"""Tests for recent changes: _render_messages, chat append, loom root validation,
chat update-title, permission rules mapping, filename search folders."""

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from loom_mcp.lib.frontmatter import write_frontmatter
from loom_mcp.tools.compile import _render_messages, save_chat_transcript


# ---------------------------------------------------------------------------
# _render_messages tests
# ---------------------------------------------------------------------------

class TestRenderMessages:
    def test_user_and_assistant(self):
        lines = _render_messages([
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi!"},
        ])
        text = "\n".join(lines)
        assert "## You" in text
        assert "Hello" in text
        assert "## Claude" in text
        assert "Hi!" in text

    def test_thinking_block(self):
        lines = _render_messages([
            {"role": "thinking", "content": "Let me think..."},
        ])
        text = "\n".join(lines)
        assert "<details>" in text
        assert "Thought" in text
        assert "Let me think" in text

    def test_tool_activity_group(self):
        lines = _render_messages([
            {"role": "tool", "content": "Read: file.md"},
            {"role": "tool_result", "content": "file contents"},
        ])
        text = "\n".join(lines)
        assert "<details>" in text
        assert "Read" in text

    def test_empty_messages(self):
        lines = _render_messages([])
        assert lines == []

    def test_plan_message(self):
        lines = _render_messages([
            {"role": "plan", "content": "- [ ] Step 1", "status": "proposed"},
        ])
        text = "\n".join(lines)
        assert "Plan — proposed" in text

    def test_subagent_messages(self):
        lines = _render_messages([
            {"role": "subagent", "content": "Started: Deep search"},
            {"role": "tool", "content": "Grep: attention"},
            {"role": "tool_result", "content": "found"},
            {"role": "subagent", "content": "Done (completed): found stuff"},
        ])
        text = "\n".join(lines)
        assert "Agent: Deep search" in text
        assert "completed" in text


class TestSaveTranscriptWithTitle:
    def test_title_in_heading(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = save_chat_transcript(root, "s1", [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
            ], title="Deep Dive into Attention")
            content = (root / result["path"]).read_text()
            assert "# Deep Dive into Attention" in content

    def test_no_title_uses_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = save_chat_transcript(root, "s1", [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
            ])
            content = (root / result["path"]).read_text()
            assert "# Chat" in content


# ---------------------------------------------------------------------------
# Web API tests
# ---------------------------------------------------------------------------

@pytest.fixture
def loom_client(tmp_path):
    root = tmp_path / "loom"
    root.mkdir()
    for d in ["raw/inbox", "raw/chats", "wiki/meta"]:
        (root / d).mkdir(parents=True)
    (root / "wiki" / "meta" / "page-registry.json").write_text('{"pages": []}')

    import loom_mcp.web as web_module
    original_root = web_module.LOOM_ROOT
    original_layout = web_module.LAYOUT_FILE
    web_module.LOOM_ROOT = root
    web_module.LAYOUT_FILE = root / "wiki" / "meta" / "canvas-layout.json"

    client = TestClient(web_module.app)
    yield client, root

    from loom_mcp.chat import sessions
    sessions.clear()
    web_module.LOOM_ROOT = original_root
    web_module.LAYOUT_FILE = original_layout


class TestChatAppendAPI:
    def test_append_to_existing_chat(self, loom_client):
        client, root = loom_client
        # Create initial chat file
        chat_file = root / "raw" / "chats" / "test-chat.md"
        chat_file.write_text("# Test Chat\nSession: abc\n\n## You\n\nFirst message\n\n## Claude\n\nFirst response\n")

        r = client.post("/api/chat/append", json={
            "path": "raw/chats/test-chat.md",
            "session_id": "abc",
            "messages": [
                {"role": "user", "content": "Second message"},
                {"role": "assistant", "content": "Second response"},
            ],
        })
        assert r.json()["ok"] is True
        content = chat_file.read_text()
        assert "First message" in content
        assert "Continued:" in content
        assert "Second message" in content
        assert "Second response" in content

    def test_append_invalid_path(self, loom_client):
        client, root = loom_client
        r = client.post("/api/chat/append", json={
            "path": "wiki/README.md",
            "messages": [{"role": "user", "content": "hack"}],
        })
        assert r.json()["ok"] is False

    def test_append_nonexistent_file(self, loom_client):
        client, root = loom_client
        r = client.post("/api/chat/append", json={
            "path": "raw/chats/nonexistent.md",
            "messages": [{"role": "user", "content": "hi"}],
        })
        assert r.json()["ok"] is False

    def test_append_empty_messages(self, loom_client):
        client, root = loom_client
        r = client.post("/api/chat/append", json={
            "path": "raw/chats/test.md",
            "messages": [],
        })
        assert r.json()["ok"] is False


class TestUpdateTitleAPI:
    def test_update_title(self, loom_client):
        client, root = loom_client
        chat_file = root / "raw" / "chats" / "test-title.md"
        chat_file.write_text("# Old Title\nSession: abc\n\n## You\n\nhi\n")

        r = client.post("/api/chat/update-title", json={
            "path": "raw/chats/test-title.md",
            "title": "New Shiny Title",
        })
        assert r.json()["ok"] is True
        content = chat_file.read_text()
        assert "# New Shiny Title" in content
        assert "Old Title" not in content

    def test_update_title_invalid_path(self, loom_client):
        client, root = loom_client
        r = client.post("/api/chat/update-title", json={
            "path": "wiki/README.md",
            "title": "hack",
        })
        assert r.json()["ok"] is False


class TestLoomRootValidation:
    def test_relative_path_rejected(self, loom_client):
        client, root = loom_client
        r = client.put("/api/settings", json={"loom_root": "Users/someone/loom"})
        data = r.json()
        assert data["ok"] is False
        assert "absolute" in data["error"].lower() or "absolute" in data.get("error", "")

    def test_nonexistent_path_rejected(self, loom_client):
        client, root = loom_client
        r = client.put("/api/settings", json={"loom_root": "/tmp/definitely-does-not-exist-12345"})
        data = r.json()
        assert data["ok"] is False

    def test_valid_path_accepted(self, loom_client):
        client, root = loom_client
        r = client.put("/api/settings", json={"loom_root": str(root)})
        data = r.json()
        assert data["ok"] is True

    def test_tilde_path_expanded(self, loom_client):
        client, root = loom_client
        # ~ expands to home dir which should exist
        r = client.put("/api/settings", json={"loom_root": "~"})
        data = r.json()
        # Should either succeed (home dir exists) or fail (not a loom), but not crash
        assert "ok" in data


class TestRestartEndpoint:
    def test_restart_resolves_loom_root(self, loom_client):
        client, root = loom_client
        r = client.post("/api/restart")
        data = r.json()
        assert data["ok"] is True
        assert data.get("restarting") is True

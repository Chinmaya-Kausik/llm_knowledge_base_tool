"""Functional tests for the loom chat system.

Tests verify ACTUAL behavior a user would see through the WebSocket and HTTP APIs.
No internal functions are imported — everything goes through FastAPI TestClient.

Tests 1-4 require Claude authentication and are wrapped in try/except + skip.
Tests 5-10 always run (no Claude needed).

To run:  uv run pytest loom_mcp/tests/test_functional.py -v
"""

import json
import subprocess
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _claude_is_authenticated() -> bool:
    """Check whether the Claude CLI is authenticated."""
    try:
        result = subprocess.run(
            ["claude", "auth", "status"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


CLAUDE_AUTHED = _claude_is_authenticated()


def _make_loom(tmp_path: Path) -> Path:
    """Bootstrap a minimal loom with searchable content."""
    from loom_mcp.lib.frontmatter import write_frontmatter

    root = tmp_path / "loom"
    root.mkdir()

    # Standard directories
    for d in [
        "raw/inbox", "raw/chats",
        "wiki/meta", "wiki/concepts",
        "projects/demo",
    ]:
        (root / d).mkdir(parents=True, exist_ok=True)

    # Page registry
    (root / "wiki" / "meta" / "page-registry.json").write_text(
        '{"pages": []}', encoding="utf-8",
    )

    # Master index
    write_frontmatter(
        root / "wiki" / "meta" / "index.md",
        {"title": "Master Index", "type": "structure-note"},
        "# Master Index\n\n- **Transformers** — neural network architecture\n",
    )

    # Glossary
    write_frontmatter(
        root / "wiki" / "meta" / "glossary.md",
        {
            "title": "Glossary",
            "type": "structure-note",
            "status": "compiled",
            "created": "2026-04-04",
            "last_compiled": "2026-04-04T00:00:00Z",
        },
        "# Glossary\n\n## transformer\n\nA neural network architecture.\n",
    )

    # A concept folder page
    transformers = root / "wiki" / "concepts" / "transformers"
    transformers.mkdir(parents=True)
    write_frontmatter(
        transformers / "README.md",
        {
            "title": "Transformers",
            "type": "concept",
            "status": "compiled",
            "created": "2026-04-04",
            "last_compiled": "2026-04-04T00:00:00Z",
            "tags": ["machine-learning", "deep-learning"],
            "related": [],
            "aliases": [],
            "confidence": "high",
            "sources": [],
        },
        "# Transformers\n\nAttention is all you need.\n\nSelf-attention computes queries, keys, and values.\n",
    )

    # A code file inside the concept
    (transformers / "attention.py").write_text(
        "def self_attention(Q, K, V):\n    scores = Q @ K.T\n    return softmax(scores) @ V\n"
    )

    # A project README
    write_frontmatter(
        root / "projects" / "demo" / "README.md",
        {"title": "Demo Project", "type": "project"},
        "# Demo Project\n\nUses [[Transformers]] internally.\n",
    )

    return root


@pytest.fixture
def loom_client(tmp_path):
    """Yield (TestClient, loom_root) with LOOM_ROOT pointed at temp loom."""
    root = _make_loom(tmp_path)

    import loom_mcp.web as web_module

    original_root = web_module.LOOM_ROOT
    original_layout = web_module.LAYOUT_FILE
    web_module.LOOM_ROOT = root
    web_module.LAYOUT_FILE = root / "wiki" / "meta" / "canvas-layout.json"

    client = TestClient(web_module.app)
    yield client, root

    web_module.LOOM_ROOT = original_root
    web_module.LAYOUT_FILE = original_layout


# ---------------------------------------------------------------------------
# Helper to collect WebSocket events until termination
# ---------------------------------------------------------------------------

def _collect_events(ws, max_events=200, timeout=60):
    """Read events from a WebSocket until done/stopped/error or max_events."""
    events = []
    for _ in range(max_events):
        try:
            resp = ws.receive_json()
            events.append(resp)
            if resp.get("type") in ("done", "stopped", "error"):
                break
        except Exception:
            break
    return events


# ===================================================================
# TESTS 1-4: Require Claude — skipped if not authenticated
# ===================================================================

@pytest.mark.skipif(not CLAUDE_AUTHED, reason="Claude CLI not authenticated")
class TestChatWithClaude:
    """Tests that send real messages through the Claude Code subprocess.

    These cost tokens. Comment out this entire class when chat is stable.
    """

    # 1. Basic chat --------------------------------------------------

    def test_basic_chat_flow(self, loom_client):
        """Connect, init, send message, receive text events, receive done."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            # Init
            ws.send_json({
                "type": "init",
                "session_id": "func-basic",
                "page_path": "",
            })
            init_resp = ws.receive_json()
            assert init_resp["type"] == "init"
            assert init_resp["session_id"] == "func-basic"

            # Send a trivial message
            ws.send_json({
                "type": "message",
                "text": "Reply with exactly the word PONG and nothing else.",
                "context_level": "page",
                "context": {},
            })

            events = _collect_events(ws)
            event_types = [e["type"] for e in events]

            # Must end with done (or error if Claude fails)
            terminal = event_types[-1] if event_types else None
            assert terminal in ("done", "error"), f"Terminal event: {terminal}"

            # At least one text event should have been streamed
            text_events = [e for e in events if e["type"] == "text"]
            assert len(text_events) > 0, f"No text events. Types: {event_types}"

            full_text = "".join(e.get("content", "") for e in text_events)
            assert len(full_text) > 0

    # 2. Tool use ----------------------------------------------------

    def test_tool_use_events(self, loom_client):
        """Ask Claude to grep the loom; verify tool_use and tool_result arrive."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "init",
                "session_id": "func-tools",
                "page_path": "",
            })
            ws.receive_json()  # init ack

            ws.send_json({
                "type": "message",
                "text": (
                    "Use the ripgrep_search tool to search for 'attention' in the loom. "
                    "Report what you find."
                ),
                "context_level": "page",
                "context": {},
            })

            events = _collect_events(ws, max_events=300, timeout=90)
            event_types = [e["type"] for e in events]

            # Should contain tool_use and tool_result events
            tool_use_events = [e for e in events if e["type"] == "tool_use"]
            tool_result_events = [e for e in events if e["type"] == "tool_result"]

            assert len(tool_use_events) > 0, (
                f"Expected tool_use events. Got types: {event_types}"
            )
            assert len(tool_result_events) > 0, (
                f"Expected tool_result events. Got types: {event_types}"
            )

            # Verify tool_use has expected fields
            tu = tool_use_events[0]
            assert "tool" in tu, f"tool_use missing 'tool': {tu}"
            assert "input" in tu, f"tool_use missing 'input': {tu}"

            # Verify tool_result has output field
            tr = tool_result_events[0]
            assert "output" in tr, f"tool_result missing 'output': {tr}"

            # subagent_id may be None (no subagent) or a string
            for e in tool_use_events + tool_result_events:
                assert "subagent_id" in e, f"Missing subagent_id: {e}"

    # 3. Multi-turn --------------------------------------------------

    def test_multi_turn_context(self, loom_client):
        """Send two messages; second response should reference prior context."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "init",
                "session_id": "func-multi",
                "page_path": "",
            })
            ws.receive_json()  # init

            # Turn 1: establish a fact
            ws.send_json({
                "type": "message",
                "text": "Remember: the secret word is BANANA. Acknowledge you understand.",
                "context_level": "page",
                "context": {},
            })
            events_1 = _collect_events(ws)
            assert any(e["type"] == "done" for e in events_1), "Turn 1 did not complete"

            # Turn 2: ask about the established fact
            ws.send_json({
                "type": "message",
                "text": "What is the secret word I told you?",
                "context_level": "page",
                "context": {},
            })
            events_2 = _collect_events(ws)
            text_2 = "".join(
                e.get("content", "") for e in events_2 if e["type"] == "text"
            )
            assert "BANANA" in text_2.upper(), (
                f"Second turn did not reference prior context. Got: {text_2[:200]}"
            )

    # 4. Stop --------------------------------------------------------

    def test_stop_and_resume(self, loom_client):
        """Start generating, send stop, verify stopped, then send new message."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "init",
                "session_id": "func-stop",
                "page_path": "",
            })
            ws.receive_json()  # init

            # Start a long-ish generation
            ws.send_json({
                "type": "message",
                "text": "Write a very long detailed essay about the history of computing.",
                "context_level": "page",
                "context": {},
            })

            # Wait for at least one text event, then stop
            got_text = False
            for _ in range(50):
                try:
                    resp = ws.receive_json()
                    if resp.get("type") == "text":
                        got_text = True
                        break
                    if resp.get("type") in ("done", "error"):
                        break
                except Exception:
                    break

            # Send stop
            ws.send_json({"type": "stop"})

            # Collect remaining events — should end with "stopped" or "done"
            remaining = _collect_events(ws, max_events=50)
            terminal_types = {e["type"] for e in remaining}
            assert "stopped" in terminal_types or "done" in terminal_types, (
                f"Expected stopped or done. Got: {terminal_types}"
            )

            # Now send a new message to verify the connection still works
            ws.send_json({
                "type": "message",
                "text": "Say OK",
                "context_level": "page",
                "context": {},
            })
            events_after = _collect_events(ws)
            types_after = {e["type"] for e in events_after}
            assert "done" in types_after or "text" in types_after or "error" in types_after, (
                f"Connection broken after stop. Got: {types_after}"
            )


# ===================================================================
# TESTS 5-10: No Claude needed — always run
# ===================================================================

# 5. Chat save -------------------------------------------------------

class TestChatSave:
    def test_save_basic_messages(self, loom_client):
        """POST /api/chat/save with various roles; verify file is created."""
        client, root = loom_client

        messages = [
            {"role": "user", "content": "What are transformers?"},
            {"role": "assistant", "content": "Transformers are a neural network architecture."},
            {"role": "user", "content": "Tell me more about attention."},
            {"role": "assistant", "content": "Attention computes relevance scores."},
        ]

        resp = client.post("/api/chat/save", json={
            "session_id": "save-basic",
            "messages": messages,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert "path" in data

        # Verify the file exists and contains all content
        saved_file = root / data["path"]
        assert saved_file.exists(), f"Saved file not found at {saved_file}"

        content = saved_file.read_text(encoding="utf-8")
        assert "transformers" in content.lower()
        assert "neural network" in content.lower()
        assert "attention" in content.lower()
        assert "relevance scores" in content.lower()

    def test_save_empty_messages_fails(self, loom_client):
        """Saving with no messages should fail gracefully."""
        client, root = loom_client

        resp = client.post("/api/chat/save", json={
            "session_id": "save-empty",
            "messages": [],
        })
        data = resp.json()
        assert data["ok"] is False


# 6. Chat save completeness ------------------------------------------

class TestChatSaveCompleteness:
    def test_save_includes_tool_calls_and_text_after(self, loom_client):
        """Save a conversation with tool calls; verify all parts are preserved."""
        client, root = loom_client

        messages = [
            {"role": "user", "content": "Search for transformers"},
            {"role": "tool", "content": "Grep: transformer in wiki/"},
            {"role": "tool_result", "content": "Found 3 matches in attention.py"},
            {"role": "assistant", "content": "I found references to transformers in the loom."},
            {"role": "user", "content": "Can you read one of those files?"},
            {"role": "tool", "content": "Read: wiki/concepts/transformers/attention.py"},
            {"role": "tool_result", "content": "def self_attention(Q, K, V): ..."},
            {"role": "assistant", "content": "The file implements self-attention with Q, K, V matrices."},
        ]

        resp = client.post("/api/chat/save", json={
            "session_id": "save-complete",
            "messages": messages,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True

        content = (root / data["path"]).read_text(encoding="utf-8")

        # Tool calls preserved
        assert "Grep" in content
        assert "Found 3 matches" in content

        # Second tool call preserved
        assert "Read" in content
        assert "self_attention" in content

        # Text AFTER tool calls preserved (this is the key completeness check)
        assert "I found references" in content
        assert "Q, K, V matrices" in content

    def test_save_with_thinking_and_subagent(self, loom_client):
        """Thinking and subagent roles should also be saved."""
        client, root = loom_client

        messages = [
            {"role": "user", "content": "Deep search for ML topics"},
            {"role": "thinking", "content": "I should search broadly first"},
            {"role": "subagent", "content": "Started: Comprehensive search"},
            {"role": "tool", "content": "Glob: wiki/**/*.md"},
            {"role": "tool_result", "content": "Found 5 files"},
            {"role": "subagent", "content": "Done (completed): Found all relevant pages"},
            {"role": "assistant", "content": "Here is what I found about ML."},
        ]

        resp = client.post("/api/chat/save", json={
            "session_id": "save-rich",
            "messages": messages,
        })
        data = resp.json()
        assert data["ok"] is True

        content = (root / data["path"]).read_text(encoding="utf-8")
        assert "search broadly" in content.lower() or "thinking" in content.lower()
        assert "Comprehensive search" in content or "subagent" in content.lower()
        assert "Here is what I found" in content


# 7. Settings --------------------------------------------------------

class TestSettings:
    def test_get_settings_returns_expected_fields(self, loom_client):
        """GET /api/settings returns loom_root and claude_authenticated."""
        client, root = loom_client

        resp = client.get("/api/settings")
        assert resp.status_code == 200
        data = resp.json()

        assert "loom_root" in data
        assert "claude_authenticated" in data
        assert isinstance(data["loom_root"], str)
        assert isinstance(data["claude_authenticated"], bool)
        # loom_root should point to our temp loom
        assert str(root) in data["loom_root"]


# 8. Search ----------------------------------------------------------

import subprocess
_HAS_RG = False
try:
    _HAS_RG = subprocess.run(["rg", "--version"], capture_output=True).returncode == 0
except FileNotFoundError:
    pass

@pytest.mark.skipif(not _HAS_RG, reason="ripgrep not installed")
class TestSearch:
    def test_search_returns_results(self, loom_client):
        """GET /api/search?q=attention returns results with path/line/context."""
        client, root = loom_client

        resp = client.get("/api/search", params={"q": "attention"})
        assert resp.status_code == 200
        results = resp.json()

        assert isinstance(results, list)
        assert len(results) > 0, "Expected at least one search result for 'attention'"

        # Each result should have path, line, context
        for r in results:
            assert "path" in r, f"Result missing 'path': {r}"
            assert "line" in r, f"Result missing 'line': {r}"
            assert "context" in r, f"Result missing 'context': {r}"

    def test_search_scoped_to_wiki(self, loom_client):
        """Search with scope=wiki should only return wiki results."""
        client, root = loom_client

        resp = client.get("/api/search", params={"q": "attention", "scope": "wiki"})
        assert resp.status_code == 200
        results = resp.json()

        for r in results:
            assert "wiki" in r["path"] or r["path"] == "", (
                f"Expected wiki scope, got path: {r['path']}"
            )

    def test_search_no_results(self, loom_client):
        """Search for something that does not exist returns empty list."""
        client, root = loom_client

        resp = client.get("/api/search", params={"q": "xyznonexistent12345"})
        assert resp.status_code == 200
        results = resp.json()
        assert isinstance(results, list)
        assert len(results) == 0


# 9. Graph -----------------------------------------------------------

class TestGraph:
    def test_graph_returns_structure(self, loom_client):
        """GET /api/graph returns nodes, edges, top_nodes, top_edges."""
        client, root = loom_client

        resp = client.get("/api/graph")
        assert resp.status_code == 200
        data = resp.json()

        assert "nodes" in data
        assert "edges" in data
        assert "top_nodes" in data
        assert "top_edges" in data

        assert isinstance(data["nodes"], list)
        assert isinstance(data["edges"], list)
        assert isinstance(data["top_nodes"], list)
        assert isinstance(data["top_edges"], list)

    def test_graph_contains_loom_pages(self, loom_client):
        """Graph nodes should include pages from the loom."""
        client, root = loom_client

        data = client.get("/api/graph").json()
        node_labels = {n["data"]["label"] for n in data["nodes"]}

        # Our loom has a transformers concept (folder name is lowercase)
        node_labels_lower = {l.lower() for l in node_labels}
        assert "transformers" in node_labels_lower, (
            f"Expected 'transformers' in graph nodes. Got: {node_labels}"
        )

    def test_graph_node_structure(self, loom_client):
        """Each graph node should have the expected data fields."""
        client, root = loom_client

        data = client.get("/api/graph").json()
        assert len(data["nodes"]) > 0

        node = data["nodes"][0]
        assert "data" in node
        d = node["data"]
        assert "id" in d
        assert "label" in d


# 10. Page read -------------------------------------------------------

class TestPageRead:
    def test_page_returns_frontmatter_and_content(self, loom_client):
        """GET /api/page/{path} returns frontmatter and content."""
        client, root = loom_client

        resp = client.get("/api/page/wiki/concepts/transformers/README.md")
        assert resp.status_code == 200
        data = resp.json()

        assert "frontmatter" in data
        assert "content" in data
        assert data["frontmatter"]["title"] == "Transformers"
        assert "concept" in data["frontmatter"].get("type", "")

    def test_page_content_has_no_yaml_markers(self, loom_client):
        """Content returned by page read should NOT contain YAML frontmatter markers."""
        client, root = loom_client

        resp = client.get("/api/page/wiki/concepts/transformers/README.md")
        data = resp.json()
        content = data["content"]

        # Content should NOT start with --- (YAML frontmatter delimiter)
        assert not content.strip().startswith("---"), (
            f"Content should not contain YAML markers. Got: {content[:100]}"
        )

        # Content should be the actual markdown body
        assert "Attention is all you need" in content

    def test_page_not_found(self, loom_client):
        """Reading a nonexistent page should return 404."""
        client, root = loom_client

        resp = client.get("/api/page/wiki/nonexistent/page.md")
        assert resp.status_code == 404

    def test_page_read_code_file(self, loom_client):
        """Reading a code file (non-markdown) should also work."""
        client, root = loom_client

        resp = client.get("/api/page/wiki/concepts/transformers/attention.py")
        assert resp.status_code == 200
        data = resp.json()
        assert "self_attention" in data["content"]


# ===================================================================
# WebSocket protocol tests (no Claude needed)
# ===================================================================

class TestWebSocketProtocol:
    """WebSocket handshake and error handling — no Claude subprocess."""

    def test_connect_and_init(self, loom_client):
        """WebSocket connects and init returns session_id."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "init",
                "session_id": "proto-init",
                "page_path": "wiki/concepts/transformers",
            })
            resp = ws.receive_json()
            assert resp["type"] == "init"
            assert resp["session_id"] == "proto-init"

    def test_message_before_init_errors(self, loom_client):
        """Sending a message before init should return an error."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({"type": "message", "text": "Hello"})
            resp = ws.receive_json()
            assert resp["type"] == "error"
            assert "Not initialized" in resp["message"]

    def test_empty_message_errors(self, loom_client):
        """Sending an empty text message should return an error."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({"type": "init", "session_id": "proto-empty", "page_path": ""})
            ws.receive_json()  # init ack

            ws.send_json({"type": "message", "text": "", "context_level": "page", "context": {}})
            resp = ws.receive_json()
            assert resp["type"] == "error"
            assert "Empty" in resp["message"]

    def test_invalid_json_errors(self, loom_client):
        """Sending malformed JSON should return an error, not crash."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_text("{invalid json!!!")
            resp = ws.receive_json()
            assert resp["type"] == "error"
            assert "Invalid JSON" in resp["message"]

    def test_unknown_type_does_not_crash(self, loom_client):
        """Sending an unknown message type should not crash the connection."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({"type": "unknown_type_xyz"})
            # Connection should still be alive — send init to verify
            ws.send_json({"type": "init", "session_id": "proto-unknown", "page_path": ""})
            resp = ws.receive_json()
            assert resp["type"] == "init"

    def test_init_generates_session_id_if_missing(self, loom_client):
        """Init without session_id should auto-generate one."""
        client, root = loom_client

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({"type": "init", "page_path": ""})
            resp = ws.receive_json()
            assert resp["type"] == "init"
            assert resp["session_id"]  # non-empty
            assert len(resp["session_id"]) > 0

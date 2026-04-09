"""Live chat tests — actually sends messages through the WebSocket.

These tests spawn a real Claude Code subprocess and cost tokens.
Comment out when chat is stable to avoid eating into Max plan.

To run: uv run pytest loom_mcp/tests/test_chat_live.py -v
"""

import json
import tempfile
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from loom_mcp.lib.frontmatter import write_frontmatter


def _make_loom(tmp: str) -> Path:
    root = Path(tmp) / "loom"
    root.mkdir()
    wiki = root / "wiki"
    (wiki / "meta").mkdir(parents=True)
    (wiki / "meta" / "page-registry.json").write_text('{"pages": []}')
    write_frontmatter(wiki / "meta" / "index.md", {"title": "Master Index"}, "# Index\n- Test page\n")
    concepts = wiki / "pages"
    concepts.mkdir(parents=True)
    write_frontmatter(concepts / "ABOUT.md", {"title": "Concepts"}, "# Concepts\n\nTest concepts.\n")
    return root


@pytest.fixture
def live_client(tmp_path):
    """Create a test client with a live loom."""
    root = _make_loom(str(tmp_path))

    import loom_mcp.web as web_module
    original_root = web_module.LOOM_ROOT
    original_layout = web_module.LAYOUT_FILE
    web_module.LOOM_ROOT = root
    web_module.LAYOUT_FILE = root / "wiki" / "meta" / "canvas-layout.json"

    client = TestClient(web_module.app)
    yield client, root

    web_module.LOOM_ROOT = original_root
    web_module.LAYOUT_FILE = original_layout


def test_websocket_connect_and_init(live_client):
    """Test that WebSocket connects and init message works."""
    client, root = live_client

    with client.websocket_connect("/ws/chat") as ws:
        # Send init
        ws.send_json({"type": "init", "session_id": "test-123", "page_path": ""})
        # Should get init response
        resp = ws.receive_json()
        assert resp["type"] == "init"
        assert resp["session_id"] == "test-123"


def test_websocket_missing_init(live_client):
    """Sending a message before init should return error."""
    client, root = live_client

    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "message", "text": "Hello"})
        resp = ws.receive_json()
        assert resp["type"] == "error"
        assert "Not initialized" in resp["message"]


def test_websocket_empty_message(live_client):
    """Sending empty text should return error."""
    client, root = live_client

    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "init", "session_id": "test-empty", "page_path": ""})
        ws.receive_json()  # init response

        ws.send_json({"type": "message", "text": "", "context_level": "page"})
        resp = ws.receive_json()
        assert resp["type"] == "error"
        assert "Empty" in resp["message"]


def test_websocket_invalid_json(live_client):
    """Sending invalid JSON should return error, not crash."""
    client, root = live_client

    with client.websocket_connect("/ws/chat") as ws:
        ws.send_text("not valid json {{{")
        resp = ws.receive_json()
        assert resp["type"] == "error"
        assert "Invalid JSON" in resp["message"]


def test_websocket_missing_type(live_client):
    """Sending JSON without type field should not crash."""
    client, root = live_client

    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"foo": "bar"})
        # Should not crash — msg_type will be None, no branch matches, loop continues
        # Send a valid init to verify connection is still alive
        ws.send_json({"type": "init", "session_id": "test-notype", "page_path": ""})
        resp = ws.receive_json()
        assert resp["type"] == "init"


# --- Tests below actually call Claude and cost tokens ---
# Uncomment when needed for debugging, comment out when stable

# def test_websocket_send_message_gets_response(live_client):
#     """Send a simple message and verify we get streaming response events."""
#     client, root = live_client
#
#     with client.websocket_connect("/ws/chat") as ws:
#         ws.send_json({"type": "init", "session_id": "test-msg", "page_path": ""})
#         ws.receive_json()  # init
#
#         ws.send_json({
#             "type": "message",
#             "text": "Say exactly: hello test",
#             "context_level": "page",
#             "context": {},
#         })
#
#         # Collect events until done
#         events = []
#         for _ in range(50):  # Max 50 events
#             try:
#                 resp = ws.receive_json(timeout=30)
#                 events.append(resp)
#                 if resp["type"] in ("done", "stopped", "error"):
#                     break
#             except Exception:
#                 break
#
#         event_types = {e["type"] for e in events}
#         assert "done" in event_types or "error" in event_types, f"Got events: {event_types}"
#         # Should have at least one text event
#         text_events = [e for e in events if e["type"] == "text"]
#         if text_events:
#             full_text = "".join(e.get("content", "") for e in text_events)
#             assert len(full_text) > 0

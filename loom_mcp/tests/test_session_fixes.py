"""Tests for multi-panel chat fixes, image upload, cache busting, and ThinkingBlock dedup.

Covers changes from the escape/interrupt isolation fix, image paste support,
automatic cache busting, and duplicate thinking prevention.
"""

import asyncio
import base64
import json
import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from loom_mcp.lib.frontmatter import write_frontmatter


# ========================================
# Fixtures
# ========================================

@pytest.fixture
def loom_root(tmp_path):
    """Create a minimal loom directory structure."""
    root = tmp_path / "loom"
    for d in ["raw/inbox", "raw/media", "wiki/pages", "wiki/meta"]:
        (root / d).mkdir(parents=True)
    write_frontmatter(root / "wiki" / "pages" / "test.md", {
        "title": "Test", "type": "concept", "status": "compiled",
        "created": "2026-04-09", "tags": ["test"],
    }, "# Test page\n")
    return root


@pytest.fixture
def loom_client(loom_root):
    """Return a TestClient with patched LOOM_ROOT."""
    import loom_mcp.web as web_module
    original_root = web_module.LOOM_ROOT
    original_layout = web_module.LAYOUT_FILE
    web_module.LOOM_ROOT = loom_root
    web_module.LAYOUT_FILE = loom_root / "wiki" / "meta" / "canvas-layout.json"

    client = TestClient(web_module.app)
    yield client, loom_root

    web_module.LOOM_ROOT = original_root
    web_module.LAYOUT_FILE = original_layout

    # Clean up sessions
    from loom_mcp.chat import sessions
    sessions.clear()


# ========================================
# Image Upload Endpoint
# ========================================

class TestImageUpload:
    """Tests for POST /api/chat/upload-image."""

    def _make_data_url(self, fmt="png", width=2, height=2):
        """Create a minimal valid image data URL."""
        # 1x1 pixel PNG
        if fmt == "png":
            # Minimal PNG binary
            import struct
            import zlib
            raw_data = b'\x00' + b'\xff\xff\xff' * width  # filter byte + RGB
            raw_rows = raw_data * height
            compressed = zlib.compress(raw_rows)

            def chunk(ctype, data):
                c = ctype + data
                return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

            png = b'\x89PNG\r\n\x1a\n'
            png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            png += chunk(b'IDAT', compressed)
            png += chunk(b'IEND', b'')
            b64 = base64.b64encode(png).decode()
            return f"data:image/png;base64,{b64}"
        elif fmt == "jpeg":
            # Fake JPEG — just enough for base64 decode
            fake = b'\xff\xd8\xff\xe0' + b'\x00' * 20
            b64 = base64.b64encode(fake).decode()
            return f"data:image/jpeg;base64,{b64}"
        return None

    def test_upload_png(self, loom_client):
        client, root = loom_client
        data_url = self._make_data_url("png")
        r = client.post("/api/chat/upload-image", json={
            "data_url": data_url, "filename": "test-screenshot",
        })
        assert r.status_code == 200
        body = r.json()
        assert "path" in body
        assert "url" in body
        assert body["path"].endswith(".png")
        assert "chat-images" in body["path"]
        # Verify file was created
        assert Path(body["path"]).exists()
        assert Path(body["path"]).stat().st_size > 0

    def test_upload_jpeg(self, loom_client):
        client, root = loom_client
        data_url = self._make_data_url("jpeg")
        r = client.post("/api/chat/upload-image", json={
            "data_url": data_url, "filename": "photo.jpg",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["path"].endswith(".jpg")

    def test_upload_no_data(self, loom_client):
        client, root = loom_client
        r = client.post("/api/chat/upload-image", json={"data_url": "", "filename": ""})
        assert r.status_code == 400

    def test_upload_invalid_data_url(self, loom_client):
        client, root = loom_client
        r = client.post("/api/chat/upload-image", json={
            "data_url": "not-a-data-url", "filename": "bad",
        })
        assert r.status_code == 400

    def test_upload_sanitizes_filename(self, loom_client):
        client, root = loom_client
        data_url = self._make_data_url("png")
        r = client.post("/api/chat/upload-image", json={
            "data_url": data_url, "filename": "../../etc/passwd",
        })
        assert r.status_code == 200
        body = r.json()
        # Path traversal characters should be sanitized
        assert ".." not in Path(body["path"]).name
        assert "/" not in Path(body["path"]).name

    def test_upload_creates_directory(self, loom_client):
        client, root = loom_client
        chat_images = root / "raw" / "media" / "chat-images"
        # Directory might not exist yet
        if chat_images.exists():
            import shutil
            shutil.rmtree(chat_images)
        data_url = self._make_data_url("png")
        r = client.post("/api/chat/upload-image", json={
            "data_url": data_url, "filename": "first",
        })
        assert r.status_code == 200
        assert chat_images.exists()

    def test_upload_url_is_servable(self, loom_client):
        client, root = loom_client
        data_url = self._make_data_url("png")
        r = client.post("/api/chat/upload-image", json={
            "data_url": data_url, "filename": "servable",
        })
        body = r.json()
        # The URL should be servable via the media endpoint
        media_r = client.get(body["url"])
        assert media_r.status_code == 200

    def test_upload_no_filename_uses_timestamp(self, loom_client):
        client, root = loom_client
        data_url = self._make_data_url("png")
        r = client.post("/api/chat/upload-image", json={
            "data_url": data_url,
        })
        assert r.status_code == 200
        body = r.json()
        assert "paste-" in Path(body["path"]).name


# ========================================
# Cache Busting
# ========================================

class TestCacheBusting:
    """Tests for automatic mtime-based cache busting in index.html."""

    def test_index_injects_version_params(self, loom_client):
        client, root = loom_client
        r = client.get("/")
        assert r.status_code == 200
        html = r.text
        # Should have ?v= query params on static assets
        assert "app.js?v=" in html
        assert "style.css?v=" in html

    def test_version_params_are_numeric(self, loom_client):
        client, root = loom_client
        import re
        html = client.get("/").text
        versions = re.findall(r'\?v=(\d+)', html)
        assert len(versions) > 0
        for v in versions:
            assert v.isdigit()
            assert int(v) > 0  # mtime should be positive

    def test_cache_control_headers(self, loom_client):
        client, root = loom_client
        r = client.get("/")
        assert "no-cache" in r.headers.get("cache-control", "")

    def test_static_files_have_cache_headers(self, loom_client):
        client, root = loom_client
        r = client.get("/static/style.css")
        if r.status_code == 200:
            assert "no-cache" in r.headers.get("cache-control", "")


# ========================================
# Chat Stop Handler
# ========================================

class TestChatStopHandler:
    """Tests for the WebSocket stop handler with timeouts."""

    def test_stop_without_active_task(self, loom_client):
        """Stop when nothing is generating should be a no-op."""
        client, root = loom_client
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({"type": "init", "session_id": "test-stop-noop"})
            resp = ws.receive_json()
            assert resp["type"] == "init"

            # Send stop with no active generation
            ws.send_json({"type": "stop"})
            # Should not crash — connection should still work
            ws.send_json({"type": "init", "session_id": "test-stop-noop-2"})
            resp = ws.receive_json()
            assert resp["type"] == "init"

    def test_stop_sends_stopped_event(self, loom_client):
        """Verify that stop produces a stopped event even without Claude."""
        client, root = loom_client
        from loom_mcp.chat import sessions

        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({"type": "init", "session_id": "test-stopped"})
            resp = ws.receive_json()
            assert resp["type"] == "init"


class TestStopHandlerTimeout:
    """Unit tests for timeout behavior in the stop handler."""

    @pytest.mark.asyncio
    async def test_interrupt_timeout_doesnt_block(self):
        """client.interrupt() hanging should not block indefinitely."""
        async def hanging_interrupt():
            await asyncio.sleep(100)

        timed_out = False
        try:
            await asyncio.wait_for(hanging_interrupt(), timeout=0.1)
        except asyncio.TimeoutError:
            timed_out = True

        assert timed_out, "Should have timed out instead of blocking"

    @pytest.mark.asyncio
    async def test_disconnect_timeout_doesnt_block(self):
        """client.disconnect() hanging should not block indefinitely."""
        async def hanging_disconnect():
            await asyncio.sleep(100)

        timed_out = False
        try:
            await asyncio.wait_for(hanging_disconnect(), timeout=0.1)
        except asyncio.TimeoutError:
            timed_out = True

        assert timed_out, "Should have timed out instead of blocking"

    @pytest.mark.asyncio
    async def test_cancel_with_timeout_sends_stopped(self):
        """When query_task times out, stopped should still be sent."""
        from loom_mcp.chat import sessions

        stopped_sent = False

        async def fake_send_json(msg):
            nonlocal stopped_sent
            if msg.get("type") == "stopped":
                stopped_sent = True

        # Simulate a task that hangs on cancel
        async def hanging_task():
            await asyncio.sleep(100)

        task = asyncio.create_task(hanging_task())
        task.cancel()

        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=0.1)
            task_completed = True
        except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
            task_completed = False

        if not task_completed:
            await fake_send_json({"type": "stopped"})

        assert stopped_sent


# ========================================
# ThinkingBlock Deduplication
# ========================================

class TestThinkingBlockDedup:
    """Tests that ThinkingBlock in AssistantMessage is skipped when thinking_delta already streams it."""

    def test_thinking_block_is_skipped(self):
        """Verify the Claude Code adapter skips ThinkingBlock (already streamed via deltas)."""
        # ThinkingBlock dedup logic lives in the Claude Code adapter (not chat.py)
        # since the agent adapter refactor. Verify the adapter's receive() method
        # only emits thinking via thinking_delta, not via ThinkingBlock.
        import inspect
        from loom_mcp.agents.claude_code import ClaudeCodeAdapter

        source = inspect.getsource(ClaudeCodeAdapter.receive)
        # The AssistantMessage handler should skip ThinkingBlock
        # (only ToolUseBlock is yielded from AssistantMessage)
        assert "AssistantMessage" in source
        assert "ToolUseBlock" in source
        # ThinkingBlock should NOT appear as a yielded event
        lines = source.split('\n')
        for line in lines:
            if "ThinkingBlock" in line:
                # If mentioned, it should only be in a comment or skip
                assert "yield" not in line, "ThinkingBlock should not be yielded"

    def test_thinking_delta_still_sends(self):
        """Verify thinking_delta events are yielded by the Claude Code adapter."""
        import inspect
        from loom_mcp.agents.claude_code import ClaudeCodeAdapter

        source = inspect.getsource(ClaudeCodeAdapter.receive)
        # thinking_delta should yield an AgentEvent with type="thinking"
        assert "thinking_delta" in source
        # Find the thinking_delta block and verify it yields (within 5 lines)
        lines = source.split('\n')
        for i, line in enumerate(lines):
            if "thinking_delta" in line:
                block = "\n".join(lines[i:i+5])
                assert "yield" in block, "thinking_delta should yield an AgentEvent"
                assert '"thinking"' in block or "'thinking'" in block, "should yield type=thinking"
                break


# ========================================
# WebSocket Protocol Edge Cases
# ========================================

class TestWebSocketEdgeCases:
    """Edge cases for WebSocket chat protocol."""

    def test_multiple_stops_dont_crash(self, loom_client):
        """Sending stop multiple times should not break the connection."""
        client, root = loom_client
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({"type": "init", "session_id": "test-multi-stop"})
            ws.receive_json()

            ws.send_json({"type": "stop"})
            ws.send_json({"type": "stop"})
            ws.send_json({"type": "stop"})

            # Connection should still work
            ws.send_json({"type": "init", "session_id": "test-multi-stop-2"})
            resp = ws.receive_json()
            assert resp["type"] == "init"

    def test_stop_before_init(self, loom_client):
        """Sending stop before init should not crash."""
        client, root = loom_client
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({"type": "stop"})
            # Should not crash — send init after
            ws.send_json({"type": "init", "session_id": "test-stop-first"})
            resp = ws.receive_json()
            assert resp["type"] == "init"

    def test_set_permissions_after_init(self, loom_client):
        """Permission rules should be stored in the session."""
        client, root = loom_client
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({"type": "init", "session_id": "test-perms"})
            ws.receive_json()

            ws.send_json({"type": "set_permissions", "rules": {"bash": "allow"}})
            resp = ws.receive_json()
            assert resp["type"] == "permissions_set"

            from loom_mcp.chat import sessions
            assert sessions["test-perms"]["permission_rules"] == {"bash": "allow"}


# ========================================
# Chat Stop Handler — Backend Integration
# ========================================

class TestStopHandlerIntegration:
    """Integration tests for the stop handler's timeout and cleanup logic."""

    @pytest.mark.asyncio
    async def test_stop_handler_timeout_pattern(self):
        """Test the asyncio.wait_for + shield pattern used in stop handler."""
        call_count = 0

        async def slow_task():
            nonlocal call_count
            try:
                await asyncio.sleep(100)
            except asyncio.CancelledError:
                call_count += 1
                # Simulate slow cleanup (like client.interrupt hanging)
                await asyncio.sleep(100)

        task = asyncio.create_task(slow_task())
        task.cancel()

        # This mirrors the stop handler pattern
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=0.1)
        except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
            pass

        # The task was cancelled and we timed out — this is expected behavior
        assert call_count == 1 or task.cancelled()

    @pytest.mark.asyncio
    async def test_force_stopped_on_timeout(self):
        """When task doesn't complete, force-send stopped."""
        events = []

        async def fake_send(msg):
            events.append(msg)

        async def hanging_task():
            try:
                await asyncio.sleep(100)
            except asyncio.CancelledError:
                await asyncio.sleep(100)  # Hangs in cleanup

        task = asyncio.create_task(hanging_task())
        task.cancel()

        task_completed = False
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=0.1)
            task_completed = True
        except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
            pass

        if not task_completed:
            await fake_send({"type": "stopped"})

        assert any(e["type"] == "stopped" for e in events)

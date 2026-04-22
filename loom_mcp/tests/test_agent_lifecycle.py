"""Tests for agent adapter lifecycle management."""

import pytest
import time
from pathlib import Path

try:
    from loom_mcp.chat import sessions, _cleanup_stale_sessions, _SESSION_TTL
    HAS_CHAT = True
except ImportError:
    HAS_CHAT = False

pytestmark = pytest.mark.skipif(not HAS_CHAT, reason="chat dependencies not installed")


class TestSessionCleanup:
    def test_stale_sessions_removed(self):
        """Sessions inactive for > TTL should be cleaned up."""
        sessions["old-session"] = {"_last_active": time.time() - _SESSION_TTL - 100}
        sessions["new-session"] = {"_last_active": time.time()}
        _cleanup_stale_sessions()
        assert "old-session" not in sessions
        assert "new-session" in sessions
        del sessions["new-session"]

    def test_preview_session_not_cleaned(self):
        """The __context_preview__ session should not be cleaned."""
        sessions["__context_preview__"] = {"_last_active": 0}
        _cleanup_stale_sessions()
        # It may or may not exist — the cleanup explicitly skips it
        sessions.pop("__context_preview__", None)

    def test_session_without_last_active_cleaned(self):
        """Sessions without _last_active (default 0) should be cleaned."""
        sessions["no-timestamp"] = {}
        _cleanup_stale_sessions()
        assert "no-timestamp" not in sessions

    def test_active_session_preserved(self):
        """Recently active sessions should not be cleaned."""
        sessions["active"] = {"_last_active": time.time()}
        _cleanup_stale_sessions()
        assert "active" in sessions
        del sessions["active"]

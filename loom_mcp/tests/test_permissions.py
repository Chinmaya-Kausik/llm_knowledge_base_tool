"""Tests for permission system — tool categorization, destructive detection, defaults."""

import re
import pytest

try:
    from loom_mcp.chat import _map_tool_to_category, _permission_futures, resolve_permission
    HAS_CHAT = True
except ImportError:
    HAS_CHAT = False

pytestmark = pytest.mark.skipif(not HAS_CHAT, reason="chat dependencies not installed")


class TestToolCategorization:
    def test_read_tools(self):
        for tool in ("Read", "Glob", "Grep", "WebSearch", "WebFetch"):
            assert _map_tool_to_category(tool) == "file_read"

    def test_write_tools(self):
        for tool in ("Write", "Edit", "NotebookEdit"):
            assert _map_tool_to_category(tool) == "file_write"

    def test_shell_tools(self):
        assert _map_tool_to_category("Bash") == "shell"

    def test_mcp_tools(self):
        assert _map_tool_to_category("mcp__my_tool") == "mcp_tools"

    def test_unknown_tools_default_to_unknown(self):
        """Unknown tools should NOT default to file_read (security risk)."""
        assert _map_tool_to_category("NewDangerousTool") == "unknown"
        assert _map_tool_to_category("SomethingElse") == "unknown"


class TestDestructiveCommandDetection:
    """Test the destructive command regex patterns from chat.py."""

    PATTERNS = [
        r'\brm\s+-', r'\brm\b.*-rf', r'\bsudo\b', r'\bchmod\b', r'\bchown\b',
        r'\bdd\b\s+', r'\bmkfs\b', r'>\s*/', r'>>\s*/',
        r'git\s+push', r'git\s+reset\s+--hard', r'git\s+clean',
        r'git\s+branch\s+-[dD]', r'git\s+push\s+--force',
    ]

    def _is_destructive(self, cmd):
        return any(re.search(p, cmd) for p in self.PATTERNS)

    def test_rm_rf_detected(self):
        assert self._is_destructive("rm -rf /tmp/something")

    def test_rm_with_flags_detected(self):
        assert self._is_destructive("rm -f file.txt")

    def test_sudo_detected(self):
        assert self._is_destructive("sudo apt-get install foo")

    def test_chmod_detected(self):
        assert self._is_destructive("chmod 777 /tmp/file")

    def test_git_push_detected(self):
        assert self._is_destructive("git push origin main")

    def test_git_push_force_detected(self):
        assert self._is_destructive("git push --force")

    def test_git_reset_hard_detected(self):
        assert self._is_destructive("git reset --hard HEAD~1")

    def test_redirect_to_root_detected(self):
        assert self._is_destructive("echo bad > /etc/passwd")

    def test_safe_commands_not_flagged(self):
        assert not self._is_destructive("ls -la")
        assert not self._is_destructive("cat file.txt")
        assert not self._is_destructive("git status")
        assert not self._is_destructive("git log --oneline")
        assert not self._is_destructive("python3 script.py")

    def test_rm_in_word_not_flagged(self):
        """'rm' inside words like 'format' should not trigger."""
        assert not self._is_destructive("echo format")
        assert not self._is_destructive("echo reform")


class TestPermissionFutureKeys:
    """Test that permission futures are keyed correctly."""

    def test_resolve_with_perm_id(self):
        import asyncio

        loop = asyncio.new_event_loop()
        future = loop.create_future()
        _permission_futures[("test-session", "abc123")] = future

        resolve_permission("test-session", "allow", "abc123")
        assert future.done()
        assert future.result() == "allow"

        _permission_futures.pop(("test-session", "abc123"), None)
        loop.close()

    def test_resolve_backward_compat(self):
        """When perm_id is empty, fall back to session-only match."""
        import asyncio

        loop = asyncio.new_event_loop()
        future = loop.create_future()
        _permission_futures[("test-session", "xyz")] = future

        resolve_permission("test-session", "deny", "")
        assert future.done()
        assert future.result() == "deny"

        _permission_futures.pop(("test-session", "xyz"), None)
        loop.close()

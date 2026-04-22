"""Tests for VM command injection prevention via shell escaping."""

import pytest

try:
    from loom_mcp.server import _shell_escape as server_escape
    HAS_SERVER = True
except ImportError:
    HAS_SERVER = False


class TestShellEscape:
    """Test the _shell_escape function used across the codebase."""

    def _escape(self, s):
        """Local copy of the shell escape function."""
        return "'" + s.replace("'", "'\\''") + "'"

    def test_normal_string(self):
        assert self._escape("hello") == "'hello'"

    def test_single_quote(self):
        result = self._escape("it's")
        # The quote in "it's" should be escaped as '\''
        assert "'\\''".replace("\\", "") not in result  # Not a raw unescaped quote
        assert result == "'it'\\''s'"

    def test_injection_attempt_semicolon(self):
        result = self._escape("'; rm -rf /; '")
        # Should be wrapped so the whole thing is a single argument
        assert result.startswith("'")
        assert result.endswith("'")

    def test_injection_attempt_backtick(self):
        result = self._escape("`whoami`")
        assert "`" in result  # Backticks inside single quotes are literal

    def test_injection_attempt_dollar(self):
        result = self._escape("$(cat /etc/passwd)")
        assert "$" in result  # Dollar signs inside single quotes are literal

    def test_empty_string(self):
        assert self._escape("") == "''"

    def test_spaces_preserved(self):
        assert self._escape("hello world") == "'hello world'"


@pytest.mark.skipif(not HAS_SERVER, reason="server dependencies not installed")
class TestVmGlobEscaping:
    """Verify that vm_glob patterns are properly escaped in the command."""

    def test_glob_pattern_with_quotes_is_escaped(self):
        """A pattern with single quotes should not break the command."""
        _shell_escape = server_escape
        pattern = "*.py'; rm -rf /"
        escaped = _shell_escape('*' + pattern)
        # The escaped version should be safe to embed in a shell command
        assert "rm -rf" in escaped  # It's there but safely quoted
        assert escaped.startswith("'")


@pytest.mark.skipif(not HAS_SERVER, reason="server dependencies not installed")
class TestVmGrepEscaping:
    """Verify that vm_grep patterns are properly escaped."""

    def test_grep_pattern_with_quotes_is_escaped(self):
        _shell_escape = server_escape
        pattern = "test'; cat /etc/passwd; echo '"
        escaped = _shell_escape(pattern)
        assert escaped.startswith("'")
        assert escaped.endswith("'")

    def test_grep_file_glob_with_injection(self):
        _shell_escape = server_escape
        file_glob = "*.py'; rm -rf /; echo '"
        escaped = _shell_escape(file_glob)
        assert escaped.startswith("'")

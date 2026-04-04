"""Tests for content hashing."""

from vault_mcp.lib.hashing import content_hash


def test_deterministic():
    """Same content always produces the same hash."""
    text = "Hello, world!"
    assert content_hash(text) == content_hash(text)


def test_different_content_different_hash():
    h1 = content_hash("Hello")
    h2 = content_hash("World")
    assert h1 != h2


def test_line_ending_normalization():
    """CRLF and LF produce the same hash."""
    assert content_hash("line1\r\nline2") == content_hash("line1\nline2")


def test_trailing_whitespace_normalization():
    """Trailing whitespace is stripped."""
    assert content_hash("content") == content_hash("content  \n")


def test_sha256_format():
    """Hash is a 64-character hex string."""
    h = content_hash("test")
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)

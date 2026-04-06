"""Tests for chat transcript saving completeness."""

import tempfile
from pathlib import Path

from vault_mcp.tools.compile import save_chat_transcript


def test_save_basic_conversation():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        result = save_chat_transcript(root, "test-basic", messages)
        content = (root / result["path"]).read_text()
        assert "## User" in content
        assert "Hello" in content
        assert "## Assistant" in content
        assert "Hi there!" in content


def test_save_includes_thinking():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "What is 2+2?"},
            {"role": "thinking", "content": "Simple arithmetic. 2+2=4."},
            {"role": "assistant", "content": "4"},
        ]
        result = save_chat_transcript(root, "test-think", messages)
        content = (root / result["path"]).read_text()
        assert "Thinking" in content or "thinking" in content.lower()
        assert "arithmetic" in content


def test_save_includes_tool_calls():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Search for transformers"},
            {"role": "tool", "content": "Grep: transformer in wiki/"},
            {"role": "tool_result", "content": "Found 3 matches"},
            {"role": "assistant", "content": "I found 3 pages about transformers."},
        ]
        result = save_chat_transcript(root, "test-tools", messages)
        content = (root / result["path"]).read_text()
        assert "Tool" in content or "tool" in content.lower()
        assert "Grep" in content
        assert "Found 3 matches" in content
        assert "I found 3 pages" in content


def test_save_includes_subagent():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Do a deep search"},
            {"role": "subagent", "content": "Started: Searching wiki"},
            {"role": "tool", "content": "Read: wiki/concepts/attention/README.md"},
            {"role": "tool_result", "content": "Attention mechanisms..."},
            {"role": "subagent", "content": "Done (completed): Found 5 pages"},
            {"role": "assistant", "content": "The search found 5 relevant pages."},
        ]
        result = save_chat_transcript(root, "test-sub", messages)
        content = (root / result["path"]).read_text()
        assert "Subagent" in content or "subagent" in content.lower()
        assert "Searching wiki" in content
        assert "Found 5 pages" in content


def test_save_text_after_tools():
    """Text that comes after tool calls must be saved."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Analyze this"},
            {"role": "assistant", "content": "Let me search first."},
            {"role": "tool", "content": "Grep: attention"},
            {"role": "tool_result", "content": "3 results"},
            {"role": "assistant", "content": "Based on the search, attention is key."},
        ]
        result = save_chat_transcript(root, "test-after", messages)
        content = (root / result["path"]).read_text()
        # Both text segments must be saved
        assert "Let me search first" in content
        assert "attention is key" in content


def test_save_complex_conversation():
    """Full complex conversation with all event types."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Search everything about ML"},
            {"role": "thinking", "content": "Need to search wiki and projects"},
            {"role": "tool", "content": "Grep: machine learning"},
            {"role": "tool_result", "content": "10 results"},
            {"role": "tool", "content": "Read: wiki/indexes/machine-learning/README.md"},
            {"role": "tool_result", "content": "ML index content..."},
            {"role": "subagent", "content": "Started: Deep search in projects"},
            {"role": "tool", "content": "Glob: projects/**/*.py"},
            {"role": "tool_result", "content": "5 files found"},
            {"role": "subagent", "content": "Done (completed): Found relevant code"},
            {"role": "thinking", "content": "Now I can synthesize"},
            {"role": "assistant", "content": "Here is a comprehensive overview of ML in your vault."},
        ]
        result = save_chat_transcript(root, "test-complex", messages)
        assert result["message_count"] == 12
        content = (root / result["path"]).read_text()
        # All types present
        assert "machine learning" in content.lower()
        assert "Deep search" in content
        assert "comprehensive overview" in content

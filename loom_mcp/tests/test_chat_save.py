"""Tests for chat transcript saving completeness."""

import tempfile
from pathlib import Path

from loom_mcp.tools.compile import save_chat_transcript


def test_save_basic_conversation():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        result = save_chat_transcript(root, "test-basic", messages)
        content = (root / result["path"]).read_text()
        assert "## You" in content
        assert "Hello" in content
        assert "## Claude" in content
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
        assert "<details>" in content
        assert "Thought" in content
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
        assert "<details>" in content
        assert "Grep" in content
        assert "Found 3 matches" in content
        assert "I found 3 pages" in content
        # Activity summary
        assert "Searched 1 pattern" in content


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
        assert "Agent: Searching wiki" in content
        assert "completed" in content
        assert "Read" in content
        assert "Attention mechanisms" in content


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
            {"role": "assistant", "content": "Here is a comprehensive overview of ML in your loom."},
        ]
        result = save_chat_transcript(root, "test-complex", messages)
        assert result["message_count"] == 12
        content = (root / result["path"]).read_text()
        assert "machine learning" in content.lower()
        assert "Deep search" in content
        assert "comprehensive overview" in content
        # Collapsible sections
        assert content.count("<details>") >= 3  # thinking + activity + subagent


def test_save_activity_summary():
    """Activity group should have human-readable summary."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Read some files"},
            {"role": "tool", "content": "Read: file1.md"},
            {"role": "tool_result", "content": "content1"},
            {"role": "tool", "content": "Read: file2.md"},
            {"role": "tool_result", "content": "content2"},
            {"role": "tool", "content": "Read: file3.md"},
            {"role": "tool_result", "content": "content3"},
            {"role": "assistant", "content": "Done reading."},
        ]
        result = save_chat_transcript(root, "test-summary", messages)
        content = (root / result["path"]).read_text()
        assert "Read 3 files" in content


def test_save_contextual_filename():
    """Chat filename should be based on first user message."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Summarize the attention mechanisms"},
            {"role": "assistant", "content": "Here's a summary..."},
        ]
        result = save_chat_transcript(root, "test-ctx", messages)
        assert "summarize-the-attention-mechanisms" in result["path"]
        assert (root / result["path"]).exists()


def test_save_contextual_filename_special_chars():
    """Special characters in messages should be stripped from filename."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "What's the [[attention]] mechanism? (explain!)"},
            {"role": "assistant", "content": "..."},
        ]
        result = save_chat_transcript(root, "test-special", messages)
        path = result["path"]
        # No brackets, parens, or exclamation marks
        filename = Path(path).name
        assert "[[" not in filename
        assert "(" not in filename
        assert (root / path).exists()


def test_save_empty_message_uses_session_id():
    """If no user messages, fall back to session ID."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "assistant", "content": "Hello!"},
        ]
        result = save_chat_transcript(root, "abcd1234-test", messages)
        assert "abcd1234" in result["path"]


def test_save_filename_has_timestamp():
    """Filename should include date and time."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "hey"},
            {"role": "assistant", "content": "hi"},
        ]
        result = save_chat_transcript(root, "test-time", messages)
        import re
        # Should match pattern: hey_YYYY-MM-DD_HHMM.md
        assert re.search(r'hey_\d{4}-\d{2}-\d{2}_\d{4}\.md', result["path"])

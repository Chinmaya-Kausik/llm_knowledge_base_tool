"""Tests for redirect context building and chat save completeness.

These tests simulate the frontend's chatMessages array and test:
1. Redirect context includes full subagent progress
2. Chat save captures everything even with tool calls and subagents
3. subagent_id filtering works correctly
"""

import tempfile
from pathlib import Path

from loom_mcp.tools.compile import save_chat_transcript


# ============================================================
# Simulate chatMessages as the frontend builds them
# ============================================================

def make_simple_chat():
    """User sends message, Claude responds with text."""
    return [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
    ]


def make_chat_with_tools():
    """User triggers tool use, text before AND after tools."""
    return [
        {"role": "user", "content": "Search for transformers"},
        {"role": "thinking", "content": "I should search the wiki", "subagent_id": None},
        {"role": "assistant", "content": "Let me search for that."},
        {"role": "tool", "content": "Grep: transformer in wiki/", "subagent_id": None},
        {"role": "tool_result", "content": "wiki/concepts/transformers/README.md:1:# Transformer Architecture", "subagent_id": None},
        {"role": "tool", "content": "Read: wiki/concepts/transformers/README.md", "subagent_id": None},
        {"role": "tool_result", "content": "The Transformer is a neural network architecture...", "subagent_id": None},
        {"role": "assistant", "content": "I found a page about Transformer Architecture. It describes..."},
    ]


def make_chat_with_subagents():
    """User triggers subagents with their own tool calls."""
    return [
        {"role": "user", "content": "Do a comprehensive search across everything"},
        {"role": "thinking", "content": "This needs multiple agents", "subagent_id": None},
        {"role": "tool", "content": "Agent: Search wiki for ML concepts", "subagent_id": None},
        {"role": "subagent", "content": "Started: Search wiki for ML concepts"},
        # Subagent A's progress
        {"role": "thinking", "content": "I'll search for machine learning", "subagent_id": "agent-a"},
        {"role": "tool", "content": "Grep: machine learning in wiki/", "subagent_id": "agent-a"},
        {"role": "tool_result", "content": "Found 5 results in wiki/", "subagent_id": "agent-a"},
        {"role": "tool", "content": "Read: wiki/concepts/gradient-descent/README.md", "subagent_id": "agent-a"},
        {"role": "tool_result", "content": "Gradient descent content...", "subagent_id": "agent-a"},
        {"role": "tool", "content": "Read: wiki/concepts/backpropagation/README.md", "subagent_id": "agent-a"},
        {"role": "tool_result", "content": "Backpropagation content...", "subagent_id": "agent-a"},
        # Subagent B's progress (started in parallel)
        {"role": "tool", "content": "Agent: Search projects for code", "subagent_id": None},
        {"role": "subagent", "content": "Started: Search projects for code"},
        {"role": "thinking", "content": "I'll look for Python files", "subagent_id": "agent-b"},
        {"role": "tool", "content": "Glob: projects/**/*.py", "subagent_id": "agent-b"},
        {"role": "tool_result", "content": "projects/transformer-from-scratch/src/attention.py\nprojects/data-pipeline/ingest.py", "subagent_id": "agent-b"},
        {"role": "tool", "content": "Read: projects/transformer-from-scratch/src/attention.py", "subagent_id": "agent-b"},
        {"role": "tool_result", "content": "class SelfAttention(nn.Module):\n    def __init__...", "subagent_id": "agent-b"},
        # Parent text after subagents (incomplete - interrupted by redirect)
        {"role": "assistant", "content": "I'm compiling results from both searches..."},
    ]


# ============================================================
# Test: subagent progress filtering by subagent_id
# ============================================================

class TestSubagentProgressFiltering:
    def test_filter_agent_a_progress(self):
        msgs = make_chat_with_subagents()
        agent_a_msgs = [m for m in msgs if m.get("subagent_id") == "agent-a"]
        assert len(agent_a_msgs) == 7  # 1 thinking + 3 tools + 3 tool_results
        tools = [m for m in agent_a_msgs if m["role"] == "tool"]
        results = [m for m in agent_a_msgs if m["role"] == "tool_result"]
        thinking = [m for m in agent_a_msgs if m["role"] == "thinking"]
        assert len(thinking) == 1
        assert len(tools) == 3
        assert len(results) == 3
        assert "machine learning" in thinking[0]["content"]

    def test_filter_agent_b_progress(self):
        msgs = make_chat_with_subagents()
        agent_b_msgs = [m for m in msgs if m.get("subagent_id") == "agent-b"]
        tools = [m for m in agent_b_msgs if m["role"] == "tool"]
        results = [m for m in agent_b_msgs if m["role"] == "tool_result"]
        thinking = [m for m in agent_b_msgs if m["role"] == "thinking"]
        assert len(thinking) == 1
        assert len(tools) == 2
        assert len(results) == 2
        assert "Python files" in thinking[0]["content"]

    def test_parent_events_have_null_subagent_id(self):
        msgs = make_chat_with_subagents()
        parent_msgs = [m for m in msgs if m.get("subagent_id") is None]
        # Parent: user, thinking, tool(Agent x2), subagent(x2), assistant
        assert any(m["role"] == "user" for m in parent_msgs)
        assert any(m["role"] == "assistant" for m in parent_msgs)

    def test_no_cross_contamination(self):
        """Agent A's progress should not include Agent B's events."""
        msgs = make_chat_with_subagents()
        agent_a_msgs = [m for m in msgs if m.get("subagent_id") == "agent-a"]
        combined_content = " ".join(m["content"] for m in agent_a_msgs)
        assert "Python files" not in combined_content  # That's agent B
        assert "attention.py" not in combined_content  # That's agent B


# ============================================================
# Test: redirect context building
# ============================================================

class TestRedirectContext:
    def _build_redirect_context(self, msgs, agents, checkpoints):
        """Simulate the JS buildRedirectMessage function.

        Args:
            msgs: full chatMessages array
            agents: list of {id, desc, prompt}
            checkpoints: dict of agent_id → msg_index (or absent = continue as-is)
        """
        context = "All subagents were interrupted. Please restart them.\n\n"
        for agent in agents:
            agent_msgs = [m for m in msgs if m.get("subagent_id") == agent["id"]]
            checkpoint_idx = checkpoints.get(agent["id"])
            has_checkpoint = checkpoint_idx is not None

            if has_checkpoint:
                # Truncate to checkpoint
                progress = [m for m in agent_msgs if msgs.index(m) <= checkpoint_idx]
            else:
                progress = agent_msgs

            progress_text = "\n".join(
                f'[{m["role"].title()}]: {m["content"]}'
                for m in progress if m["role"] in ("thinking", "tool", "tool_result")
            )

            context += f'--- Agent: "{agent["desc"]}" ---\n'
            context += f'Original prompt: {agent["prompt"]}\n'
            if progress_text:
                context += f'Progress:\n{progress_text}\n'

            if has_checkpoint:
                context += f'REDIRECT: Change approach from this point.\n'
            else:
                context += f'ACTION: Continue exactly where this agent left off.\n'
            context += '\n'
        return context

    def test_redirect_with_checkpoint_truncates(self):
        msgs = make_chat_with_subagents()
        agents = [
            {"id": "agent-a", "desc": "Search wiki", "prompt": "Search wiki for ML concepts"},
            {"id": "agent-b", "desc": "Search projects", "prompt": "Search projects for code"},
        ]
        # Set checkpoint for agent-a at the first tool_result (index ~6)
        first_result_idx = next(i for i, m in enumerate(msgs) if m.get("subagent_id") == "agent-a" and m["role"] == "tool_result")
        ctx = self._build_redirect_context(msgs, agents, {"agent-a": first_result_idx})

        # Agent A should have progress up to the checkpoint only
        assert "machine learning" in ctx  # Agent A's thinking (before checkpoint)
        assert "Found 5 results" in ctx  # First tool result (at checkpoint)
        assert "REDIRECT" in ctx

        # Agent B should have ALL progress (no checkpoint)
        assert "Python files" in ctx
        assert "attention.py" in ctx
        assert "ACTION: Continue" in ctx

    def test_redirect_without_checkpoint_includes_all(self):
        msgs = make_chat_with_subagents()
        agents = [
            {"id": "agent-a", "desc": "Search wiki", "prompt": "Search wiki for ML concepts"},
        ]
        ctx = self._build_redirect_context(msgs, agents, {})  # No checkpoints
        # All of Agent A's progress should be included
        assert "machine learning" in ctx
        assert "Found 5 results" in ctx
        assert "Backpropagation" in ctx  # Later tool result
        assert "ACTION: Continue" in ctx

    def test_redirect_checkpoint_excludes_later_entries(self):
        msgs = make_chat_with_subagents()
        agents = [
            {"id": "agent-a", "desc": "Search wiki", "prompt": "Search wiki for ML concepts"},
        ]
        # Checkpoint at first tool_result — should exclude later reads
        first_result_idx = next(i for i, m in enumerate(msgs) if m.get("subagent_id") == "agent-a" and m["role"] == "tool_result")
        ctx = self._build_redirect_context(msgs, agents, {"agent-a": first_result_idx})
        # Backpropagation is from a LATER tool result — should NOT be included
        assert "Backpropagation" not in ctx

    def test_redirect_multiple_agents_checkpointed(self):
        msgs = make_chat_with_subagents()
        agents = [
            {"id": "agent-a", "desc": "Search wiki", "prompt": "Search wiki for ML concepts"},
            {"id": "agent-b", "desc": "Search projects", "prompt": "Search projects for code"},
        ]
        a_idx = next(i for i, m in enumerate(msgs) if m.get("subagent_id") == "agent-a" and m["role"] == "tool_result")
        b_idx = next(i for i, m in enumerate(msgs) if m.get("subagent_id") == "agent-b" and m["role"] == "tool_result")
        ctx = self._build_redirect_context(msgs, agents, {"agent-a": a_idx, "agent-b": b_idx})
        assert ctx.count("REDIRECT") == 2  # Both agents redirected


# ============================================================
# Test: chat save completeness with tool calls and subagents
# ============================================================

class TestChatSaveCompleteness:
    def test_save_simple(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = save_chat_transcript(root, "s1", make_simple_chat())
            content = (root / result["path"]).read_text()
            assert "Hello" in content
            assert "Hi there" in content

    def test_save_with_tools_captures_all_text(self):
        """Text before AND after tool calls must be saved."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            msgs = make_chat_with_tools()
            result = save_chat_transcript(root, "s2", msgs)
            content = (root / result["path"]).read_text()
            # Text before tools
            assert "Let me search" in content
            # Tool calls
            assert "Grep" in content
            assert "transformer" in content
            # Tool results
            assert "Transformer Architecture" in content
            # Text after tools
            assert "I found a page" in content

    def test_save_with_tools_captures_thinking(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            msgs = make_chat_with_tools()
            result = save_chat_transcript(root, "s3", msgs)
            content = (root / result["path"]).read_text()
            assert "search the wiki" in content

    def test_save_with_subagents_captures_all(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            msgs = make_chat_with_subagents()
            result = save_chat_transcript(root, "s4", msgs)
            content = (root / result["path"]).read_text()
            # Parent events
            assert "comprehensive search" in content
            assert "compiling results" in content
            # Subagent blocks (rendered as collapsible Agent: sections)
            assert "Agent: Search wiki" in content
            # Subagent tool calls
            assert "Grep" in content
            assert "Glob" in content
            # Subagent results
            assert "Found 5 results" in content
            assert "SelfAttention" in content
            # Thinking
            assert "machine learning" in content
            assert "Python files" in content

    def test_save_message_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            msgs = make_chat_with_subagents()
            result = save_chat_transcript(root, "s5", msgs)
            assert result["message_count"] == len(msgs)

    def test_save_with_subagent_ids(self):
        """Messages with subagent_id should still be saved."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            msgs = [
                {"role": "user", "content": "test"},
                {"role": "tool", "content": "Grep: test", "subagent_id": "agent-x"},
                {"role": "tool_result", "content": "found it", "subagent_id": "agent-x"},
                {"role": "assistant", "content": "Done"},
            ]
            result = save_chat_transcript(root, "s6", msgs)
            content = (root / result["path"]).read_text()
            assert "Grep" in content
            assert "found it" in content

    def test_save_incomplete_conversation(self):
        """Conversation interrupted mid-tool-use should still save what we have."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            msgs = [
                {"role": "user", "content": "Do something complex"},
                {"role": "thinking", "content": "Planning..."},
                {"role": "tool", "content": "Read: file.py"},
                {"role": "tool_result", "content": "file contents"},
                # No assistant response — interrupted
            ]
            result = save_chat_transcript(root, "s7", msgs)
            content = (root / result["path"]).read_text()
            assert "Do something complex" in content
            assert "Planning" in content
            assert "Read" in content
            assert "file contents" in content

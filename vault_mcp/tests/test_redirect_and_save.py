"""Tests for redirect context building and chat save completeness.

These tests simulate the frontend's chatMessages array and test:
1. Redirect context includes full subagent progress
2. Chat save captures everything even with tool calls and subagents
3. subagent_id filtering works correctly
"""

import tempfile
from pathlib import Path

from vault_mcp.tools.compile import save_chat_transcript


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
    def _build_redirect_context(self, msgs, redirected_id, all_agents):
        """Simulate the JS doRedirect function's context building."""
        def get_progress(agent_id):
            progress = []
            for m in msgs:
                if m.get("subagent_id") == agent_id:
                    if m["role"] == "thinking":
                        progress.append(f'[Thinking]: {m["content"]}')
                    elif m["role"] == "tool":
                        progress.append(f'[Tool]: {m["content"]}')
                    elif m["role"] == "tool_result":
                        progress.append(f'[Result]: {m["content"]}')
            return "\n".join(progress)

        context = "All subagents were interrupted and need to be restarted.\n\n"
        for agent in all_agents:
            progress = get_progress(agent["id"])
            if agent["id"] == redirected_id:
                context += f'--- REDIRECTED AGENT: "{agent["desc"]}" ---\n'
                context += f'Original prompt: {agent["prompt"]}\n'
                if progress:
                    context += f'Progress before redirect:\n{progress}\n'
                context += f'User\'s redirect instructions: '
            else:
                context += f'--- AGENT TO CONTINUE: "{agent["desc"]}" ---\n'
                context += f'Original prompt: {agent["prompt"]}\n'
                if progress:
                    context += f'Progress (continue from here):\n{progress}\n'
                context += 'Action: Restart this agent to continue exactly where it left off.\n\n'
        return context

    def test_redirect_includes_redirected_agent_progress(self):
        msgs = make_chat_with_subagents()
        agents = [
            {"id": "agent-a", "desc": "Search wiki", "prompt": "Search wiki for ML concepts"},
            {"id": "agent-b", "desc": "Search projects", "prompt": "Search projects for code"},
        ]
        ctx = self._build_redirect_context(msgs, "agent-a", agents)
        assert "REDIRECTED AGENT" in ctx
        assert "Search wiki" in ctx
        assert "machine learning" in ctx  # Agent A's thinking
        assert "Found 5 results" in ctx  # Agent A's tool result
        assert "User's redirect instructions:" in ctx

    def test_redirect_includes_other_agent_progress(self):
        msgs = make_chat_with_subagents()
        agents = [
            {"id": "agent-a", "desc": "Search wiki", "prompt": "Search wiki for ML concepts"},
            {"id": "agent-b", "desc": "Search projects", "prompt": "Search projects for code"},
        ]
        ctx = self._build_redirect_context(msgs, "agent-a", agents)
        assert "AGENT TO CONTINUE" in ctx
        assert "Search projects" in ctx
        assert "Python files" in ctx  # Agent B's thinking
        assert "attention.py" in ctx  # Agent B's tool result
        assert "continue exactly where it left off" in ctx

    def test_redirect_keeps_agents_separate(self):
        msgs = make_chat_with_subagents()
        agents = [
            {"id": "agent-a", "desc": "Search wiki", "prompt": "Search wiki for ML concepts"},
            {"id": "agent-b", "desc": "Search projects", "prompt": "Search projects for code"},
        ]
        ctx = self._build_redirect_context(msgs, "agent-a", agents)
        # Agent A section should not contain Agent B's content
        parts = ctx.split("---")
        redirected_section = [p for p in parts if "REDIRECTED" in p][0]
        assert "Python files" not in redirected_section
        assert "attention.py" not in redirected_section

    def test_redirect_single_agent(self):
        msgs = make_chat_with_subagents()
        agents = [
            {"id": "agent-a", "desc": "Search wiki", "prompt": "Search wiki for ML concepts"},
        ]
        ctx = self._build_redirect_context(msgs, "agent-a", agents)
        assert "REDIRECTED AGENT" in ctx
        assert "AGENT TO CONTINUE" not in ctx  # No other agents


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
            # Subagent markers
            assert "Started" in content
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

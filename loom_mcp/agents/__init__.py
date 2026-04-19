"""Agent adapter interface — common protocol for all coding agents."""

from dataclasses import dataclass, field
from typing import Any, AsyncIterator


@dataclass
class AgentEvent:
    """Event emitted by any agent adapter.

    Types:
        text          — streaming text delta
        thinking      — reasoning/thinking delta
        tool_use      — tool invocation (name + input)
        tool_result   — tool output
        result        — final result with usage/cost
        subagent_started   — sub-agent task started
        subagent_progress  — sub-agent progress update
        subagent_done      — sub-agent completed
        done          — generation complete
        stopped       — generation stopped by user
        error         — error occurred
        init          — session initialized (sdk_session_id)
        permissions_needed — permission request for tool use
    """
    type: str
    content: str = ""
    data: dict[str, Any] = field(default_factory=dict)


class AgentAdapter:
    """Base class for coding agent backends.

    Subclasses implement connect/query/receive/stop/disconnect.
    The WebSocket handler in chat.py consumes AgentEvents from receive()
    and forwards them to the browser — same protocol regardless of agent.
    """
    name: str = "unknown"

    async def connect(self, config: dict[str, Any]) -> None:
        """Initialize the agent with the given config."""
        raise NotImplementedError

    async def query(self, prompt: str) -> None:
        """Send a query/message to the agent."""
        raise NotImplementedError

    async def receive(self) -> AsyncIterator[AgentEvent]:
        """Yield AgentEvents as the agent responds."""
        raise NotImplementedError
        yield  # Make this a generator

    async def stop(self) -> None:
        """Interrupt the current generation."""
        pass

    async def disconnect(self) -> None:
        """Clean up resources."""
        pass


def get_adapter(agent_type: str) -> AgentAdapter:
    """Factory: return the right adapter for the given agent type."""
    if agent_type == "claude-code":
        from loom_mcp.agents.claude_code import ClaudeCodeAdapter
        return ClaudeCodeAdapter()
    elif agent_type == "codex":
        from loom_mcp.agents.codex import CodexAdapter
        return CodexAdapter()
    elif agent_type == "generic-cli":
        from loom_mcp.agents.generic_cli import GenericCLIAdapter
        return GenericCLIAdapter()
    else:
        raise ValueError(f"Unknown agent type: {agent_type}")

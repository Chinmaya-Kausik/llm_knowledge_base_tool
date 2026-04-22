"""Claude Code adapter — wraps the Agent SDK into the common AgentAdapter interface."""

import asyncio
import logging
from typing import Any, AsyncIterator

from loom_mcp.agents import AgentAdapter, AgentEvent

log = logging.getLogger("loom.agents.claude_code")


class ClaudeCodeAdapter(AgentAdapter):
    """Agent adapter for Claude Code via the Agent SDK."""
    name = "claude-code"

    def __init__(self) -> None:
        self._client: Any = None  # ClaudeSDKClient
        self._session_id: str = ""
        self._sdk_session_id: str | None = None
        self._has_run: bool = False

    async def connect(self, config: dict[str, Any]) -> None:
        """Create and connect a ClaudeSDKClient.

        Config keys:
            session_id: str — session identifier
            loom_root: str — path to loom directory
            system_prompt: str — assembled system prompt to append
            model: str | None — model name (sonnet, opus, haiku)
            permission_mode: str — "auto" or "default"
            can_use_tool: callable | None — permission handler
            precompact_hooks: list | None — hooks for pre-compaction
            resume_session_id: str | None — SDK session ID to resume
        """
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
        from claude_agent_sdk.types import HookMatcher

        self._session_id = config.get("session_id", "")
        resume_sid = config.get("resume_session_id")
        has_run = config.get("has_run", False)

        options = ClaudeAgentOptions(
            cwd=config.get("loom_root", "."),
            system_prompt={
                "type": "preset",
                "preset": "claude_code",
                "append": config.get("system_prompt", ""),
            },
            setting_sources=["project"],
            include_partial_messages=True,
            thinking={"type": "enabled", "budget_tokens": 10000},
            permission_mode=config.get("permission_mode", "auto"),
            resume=resume_sid if has_run and resume_sid else None,
            model=config.get("model"),
            can_use_tool=config.get("can_use_tool"),
            hooks=config.get("hooks", {}),
        )

        self._client = ClaudeSDKClient(options)
        await self._client.connect()
        self._has_run = True

    async def query(self, prompt: str) -> None:
        """Send a query to Claude Code."""
        if not self._client:
            raise RuntimeError("Not connected")
        await self._client.query(prompt)

    async def receive(self) -> AsyncIterator[AgentEvent]:
        """Translate Claude SDK events into AgentEvents."""
        if not self._client:
            return

        from claude_agent_sdk import (
            AssistantMessage,
            ResultMessage,
            StreamEvent,
            SystemMessage,
            TaskNotificationMessage,
            TaskProgressMessage,
            TaskStartedMessage,
            UserMessage,
        )

        current_subagent_id: str | None = None

        async for event in self._client.receive_response():
            try:
                if isinstance(event, StreamEvent):
                    ev = getattr(event, 'event', None) or {}
                    if isinstance(ev, dict):
                        delta = ev.get("delta", {})
                        if isinstance(delta, dict):
                            dtype = delta.get("type", "")
                            if dtype == "thinking_delta":
                                yield AgentEvent(
                                    type="thinking",
                                    content=delta.get("thinking", ""),
                                    data={"subagent_id": current_subagent_id},
                                )
                            elif dtype == "text_delta":
                                yield AgentEvent(
                                    type="text",
                                    content=delta.get("text", ""),
                                    data={"subagent_id": current_subagent_id},
                                )

                elif isinstance(event, AssistantMessage):
                    for block in getattr(event, 'content', []):
                        block_cls = type(block).__name__
                        if block_cls == 'ToolUseBlock':
                            yield AgentEvent(
                                type="tool_use",
                                data={
                                    "subagent_id": current_subagent_id,
                                    "tool": getattr(block, 'name', 'unknown'),
                                    "input": getattr(block, 'input', {}),
                                },
                            )

                elif isinstance(event, UserMessage):
                    for block in getattr(event, 'content', []):
                        block_cls = type(block).__name__
                        if block_cls == 'ToolResultBlock':
                            content = getattr(block, 'content', '')
                            if isinstance(content, list):
                                content = '\n'.join(
                                    getattr(item, 'text', str(item))
                                    for item in content
                                )
                            yield AgentEvent(
                                type="tool_result",
                                content=str(content)[:3000],
                                data={"subagent_id": current_subagent_id},
                            )

                elif isinstance(event, ResultMessage):
                    result = getattr(event, 'result', '')
                    usage = getattr(event, 'usage', None) or {}
                    cost = getattr(event, 'total_cost_usd', None)
                    yield AgentEvent(
                        type="result",
                        content=result or '',
                        data={"usage": usage, "cost_usd": cost},
                    )

                elif isinstance(event, TaskStartedMessage):
                    current_subagent_id = getattr(event, 'task_id', '')
                    yield AgentEvent(
                        type="subagent_started",
                        data={
                            "task_id": current_subagent_id,
                            "description": getattr(event, 'description', ''),
                            "task_type": getattr(event, 'task_type', ''),
                        },
                    )

                elif isinstance(event, TaskProgressMessage):
                    yield AgentEvent(
                        type="subagent_progress",
                        data={
                            "task_id": getattr(event, 'task_id', ''),
                            "description": getattr(event, 'description', ''),
                            "last_tool": getattr(event, 'last_tool_name', ''),
                        },
                    )

                elif isinstance(event, TaskNotificationMessage):
                    yield AgentEvent(
                        type="subagent_done",
                        data={
                            "task_id": getattr(event, 'task_id', ''),
                            "status": getattr(event, 'status', ''),
                            "summary": getattr(event, 'summary', ''),
                        },
                    )
                    current_subagent_id = None

                elif isinstance(event, SystemMessage):
                    subtype = getattr(event, 'subtype', '')
                    if subtype == 'init':
                        data = getattr(event, 'data', {})
                        if isinstance(data, dict) and 'session_id' in data:
                            self._sdk_session_id = data["session_id"]
                            yield AgentEvent(
                                type="init",
                                data={"sdk_session_id": data["session_id"]},
                            )

            except Exception as e:
                log.warning("Event parse error (skipped): %s", e)
                continue

    async def stop(self) -> None:
        """Interrupt the current Claude Code generation."""
        if self._client:
            try:
                await asyncio.wait_for(self._client.interrupt(), timeout=3.0)
            except (asyncio.TimeoutError, Exception):
                pass

    async def disconnect(self) -> None:
        """Disconnect the SDK client."""
        if self._client:
            try:
                await asyncio.wait_for(self._client.disconnect(), timeout=3.0)
            except (asyncio.TimeoutError, Exception):
                pass
            self._client = None

    @property
    def sdk_session_id(self) -> str | None:
        return self._sdk_session_id

    @property
    def has_run(self) -> bool:
        return self._has_run

"""Chat backend — WebSocket bridge to Claude Code subprocess via Agent SDK."""

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from loom_mcp.lib.pages import get_page_content, get_page_metadata

# Active sessions: session_id → state
sessions: dict[str, dict[str, Any]] = {}


async def ws_chat(websocket: WebSocket, loom_root: Path):
    """WebSocket endpoint bridging browser ↔ Claude Code subprocess.

    Protocol:
    - Browser sends JSON: {"type": "init", "session_id": "...", "page_path": "..."} or
                          {"type": "message", "text": "...", "context": {...}} or
                          {"type": "stop"}
    - Server sends JSON:  {"type": "text", "content": "..."} or
                          {"type": "thinking", "content": "..."} or
                          {"type": "tool_use", "tool": "...", "input": {...}} or
                          {"type": "tool_result", "output": "..."} or
                          {"type": "done"} or
                          {"type": "error", "message": "..."}
    """
    await websocket.accept()

    session_id = None
    query_task = None

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON"})
                continue

            msg_type = msg.get("type")

            if msg_type == "init":
                session_id = msg.get("session_id") or str(uuid.uuid4())
                sessions[session_id] = {
                    "page_path": msg.get("page_path"),
                    "history": [],
                    "model": msg.get("model"),
                    "permission_mode": msg.get("permission_mode", "auto"),
                }
                await websocket.send_json({"type": "init", "session_id": session_id})

            elif msg_type == "set_model":
                if session_id and session_id in sessions:
                    sessions[session_id]["model"] = msg.get("model")
                    await websocket.send_json({"type": "model_set", "model": msg.get("model")})

            elif msg_type == "message":
                if not session_id:
                    await websocket.send_json({"type": "error", "message": "Not initialized"})
                    continue

                text = msg.get("text", "")
                if not text:
                    await websocket.send_json({"type": "error", "message": "Empty message"})
                    continue

                context = msg.get("context", {})
                context_level = msg.get("context_level", "page")

                # Update session page path if provided
                if context.get("page_path"):
                    sessions[session_id]["page_path"] = context["page_path"]

                prompt = build_prompt(text, context, session_id, loom_root)

                query_task = asyncio.create_task(
                    stream_query(websocket, prompt, session_id, loom_root, context_level)
                )

            elif msg_type == "stop":
                # Cancel active generation and wait for cleanup
                if query_task and not query_task.done():
                    query_task.cancel()
                    try:
                        await query_task
                    except (asyncio.CancelledError, Exception):
                        pass
                    query_task = None

            elif msg_type == "permission_response":
                # Browser responded to a permission prompt
                if session_id:
                    resolve_permission(session_id, msg.get("decision", "deny"))

            elif msg_type == "set_permissions":
                # Browser sends permission rules: {category: "allow"|"ask"|"deny"}
                if session_id and session_id in sessions:
                    sessions[session_id]["permission_rules"] = msg.get("rules", {})
                    # Disconnect existing client so next query uses new rules
                    client = sessions[session_id].pop("sdk_client", None)
                    if client:
                        try:
                            await client.disconnect()
                        except Exception:
                            pass
                    await websocket.send_json({"type": "permissions_set"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        if query_task and not query_task.done():
            query_task.cancel()
        # Clean up SDK client on disconnect
        if session_id and session_id in sessions:
            client = sessions[session_id].pop("sdk_client", None)
            if client:
                try:
                    await client.disconnect()
                except Exception:
                    pass


def build_prompt(text: str, context: dict, session_id: str, loom_root: Path) -> str:
    """Build the user prompt with context injection.

    Context can include:
    - page_path: currently viewed page
    - selection: highlighted text from a page
    - selection_file: which file the selection is from
    """
    parts = []

    # Add selection context if provided
    selection = context.get("selection")
    selection_file = context.get("selection_file")
    if selection:
        if selection_file:
            parts.append(f'The user has selected this text from `{selection_file}`:\n```\n{selection}\n```\n')
        else:
            parts.append(f'The user has selected this text:\n```\n{selection}\n```\n')

    parts.append(text)
    return "\n".join(parts)


def build_system_prompt(session_id: str, loom_root: Path, context_level: str = "page") -> str:
    """Build system prompt based on context level.

    Levels:
    - page: current file content + parent folder README
    - folder: current folder README (lists children with summaries)
    - global: full master index (titles + summaries for all pages)
    """
    parts = ["""This workspace is a Loom — a unified knowledge base + project workspace.

Structure:
- wiki/ — standalone knowledge articles (each folder has a README.md)
- projects/ — active code repos, paper drafts, experiments
- raw/ — ingested sources, chat transcripts

Loom conventions:
- Pages are folders with README.md. Files are subpages.
- Cross-reference with [[wiki-links]] (e.g. [[Attention Mechanisms]])
- The master index at wiki/meta/index.md catalogs all pages
- When you discover cross-cutting knowledge, suggest adding it to the wiki

You have MCP loom tools available: ripgrep_search, write_index, update_master_index, ingest_url, auto_commit, etc. Use them when helpful.

Responsiveness: If you need to do multi-step work (searching, reading files, running tools), acknowledge first in one line (e.g. "On it — checking the wiki for attention mechanisms") before starting. Without the ack the user is staring at a spinner.

Permissions:
- You may read and write any file inside this loom directory.
- You may run MCP tools freely (search, compile, ingest, index, commit).
- You may run read-only shell commands (ls, find, grep, git status, git log).
- NEVER write or modify files outside the loom directory.
- NEVER modify .claude/ configuration files (mcp.json, settings).
- NEVER run destructive git commands (push, reset --hard, clean -f, branch -D) without explicit user approval.
- NEVER delete files without asking the user first.
- Prefer MCP tools over raw shell commands when both can accomplish the task."""]

    # Dynamic boundary — Claude Code caches everything above this marker
    # and rebuilds everything below per-request
    parts.append("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")

    session = sessions.get(session_id, {})
    page_path = session.get("page_path")

    if not page_path:
        return "\n\n".join(parts)  # Static + boundary only, no dynamic context

    if context_level == "page" and page_path:
        # Inject the current page content (truncated to avoid huge prompts)
        full_path = loom_root / page_path
        if full_path.exists():
            content = get_page_content(full_path)
            if content:
                if len(content) > 8000:
                    content = content[:8000] + "\n\n[... truncated ...]"
                parts.append(f"The user is currently viewing: `{page_path}`\n\n{content}")

            # Also inject parent folder README for local context
            parent = full_path.parent
            if parent != loom_root:
                parent_readme = parent / "README.md"
                if parent_readme.exists():
                    parent_content = get_page_content(parent)
                    if parent_content:
                        parts.append(f"\n--- Parent folder: `{parent.relative_to(loom_root)}` ---\n{parent_content}")

    elif context_level == "folder" and page_path:
        # Inject folder README (which lists children + summaries)
        full_path = loom_root / page_path
        folder = full_path if full_path.is_dir() else full_path.parent
        if folder.exists():
            content = get_page_content(folder)
            folder_rel = str(folder.relative_to(loom_root))
            parts.append(f"The user is browsing folder: `{folder_rel}`\n\n{content}")

    elif context_level == "global":
        # Inject full master index
        index_path = loom_root / "wiki" / "meta" / "index.md"
        if index_path.exists():
            try:
                from loom_mcp.lib.frontmatter import read_frontmatter
                _, index_content = read_frontmatter(index_path)
                parts.append(f"--- Master Index (all loom pages) ---\n{index_content}")
            except Exception:
                pass

    return "\n\n".join(parts)


def _map_tool_to_category(tool_name: str) -> str:
    """Map a Claude tool name to a permission category."""
    read_tools = {"Read", "Glob", "Grep", "WebSearch", "WebFetch"}
    write_tools = {"Write", "Edit", "NotebookEdit"}
    shell_tools = {"Bash"}
    destructive_git = {"git push", "git reset", "git clean", "git branch -D"}

    if tool_name in read_tools:
        return "file_read"
    if tool_name in write_tools:
        return "file_write"
    if tool_name in shell_tools:
        return "shell"
    if tool_name.startswith("mcp__"):
        return "mcp_tools"
    return "file_read"  # Default: treat unknown tools as read


def _make_permission_handler(session_id: str, websocket: WebSocket):
    """Create a can_use_tool callback that checks session permission settings.

    Permission settings come from the browser (localStorage) and are stored
    in the session dict as permission_rules: {category: "allow"|"ask"|"deny"}.
    """
    async def can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
        context: Any,
    ) -> Any:
        from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

        session = sessions.get(session_id, {})
        rules = session.get("permission_rules", {})
        category = _map_tool_to_category(tool_name)

        # Check for destructive commands in Bash
        if tool_name == "Bash":
            cmd = tool_input.get("command", "")
            import re
            if re.search(r'\brm\b', cmd) or any(
                p in cmd for p in [
                    "git push", "git reset --hard", "git clean", "git branch -D",
                    "git push --force",
                ]
            ):
                category = "destructive_git"

        rule = rules.get(category, "allow")

        if rule == "allow":
            return PermissionResultAllow()
        if rule == "deny":
            return PermissionResultDeny(message=f"Denied by user permission settings ({category})")

        # rule == "ask": forward to browser and wait for response
        try:
            # Send permission prompt to browser
            await websocket.send_json({
                "type": "permission_request",
                "tool": tool_name,
                "input": {k: str(v) for k, v in tool_input.items()},
                "category": category,
            })
            # Wait for browser response (with timeout)
            response = await asyncio.wait_for(
                _wait_for_permission_response(session_id),
                timeout=120,
            )
            if response == "allow":
                return PermissionResultAllow()
            return PermissionResultDeny(message="Denied by user")
        except asyncio.TimeoutError:
            return PermissionResultDeny(message="Permission request timed out")
        except Exception:
            return PermissionResultAllow()  # Fail open on errors

    return can_use_tool


# Pending permission responses: session_id → asyncio.Future
_permission_futures: dict[str, asyncio.Future] = {}


async def _wait_for_permission_response(session_id: str) -> str:
    """Wait for a permission response from the browser."""
    loop = asyncio.get_event_loop()
    future: asyncio.Future[str] = loop.create_future()
    _permission_futures[session_id] = future
    try:
        return await future
    finally:
        _permission_futures.pop(session_id, None)


def resolve_permission(session_id: str, decision: str) -> None:
    """Called when the browser sends a permission response."""
    future = _permission_futures.get(session_id)
    if future and not future.done():
        future.set_result(decision)


async def _get_or_create_client(session_id: str, loom_root: Path, context_level: str, websocket: WebSocket):
    """Get an existing ClaudeSDKClient for the session, or create a new one."""
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

    session = sessions.get(session_id, {})
    client = session.get("sdk_client")

    if client is not None:
        # Update system prompt for new context
        system_prompt = build_system_prompt(session_id, loom_root, context_level)
        # Client is already connected — just return it
        return client

    system_prompt = build_system_prompt(session_id, loom_root, context_level)
    model = session.get("model")
    sdk_sid = session.get("sdk_session_id")
    has_run = session.get("has_run", False)
    rules = session.get("permission_rules", {})

    # Use "default" permission mode when we have a can_use_tool callback,
    # "auto" when no rules are set (backwards compatible)
    has_rules = any(v != "allow" for v in rules.values())
    perm_mode = "default" if has_rules else "auto"
    can_use_tool_cb = _make_permission_handler(session_id, websocket) if has_rules else None

    options = ClaudeAgentOptions(
        cwd=str(loom_root),
        system_prompt=system_prompt,
        include_partial_messages=True,
        thinking={"type": "enabled", "budget_tokens": 10000},
        permission_mode=perm_mode,
        resume=sdk_sid if has_run and sdk_sid else None,
        model=model,
        can_use_tool=can_use_tool_cb,
    )

    client = ClaudeSDKClient(options)
    await client.connect()
    session["sdk_client"] = client
    session["has_run"] = True
    return client


async def stream_query(websocket: WebSocket, prompt: str, session_id: str, loom_root: Path, context_level: str = "page"):
    """Stream a Claude Code query response to the WebSocket using ClaudeSDKClient."""
    try:
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

        client = await _get_or_create_client(session_id, loom_root, context_level, websocket)
        await client.query(prompt)

        current_subagent_task_id = None

        async for event in client.receive_response():
            try:
                if isinstance(event, StreamEvent):
                    ev = getattr(event, 'event', None) or {}
                    if isinstance(ev, dict):
                        delta = ev.get("delta", {})
                        if isinstance(delta, dict):
                            dtype = delta.get("type", "")
                            if dtype == "thinking_delta":
                                await websocket.send_json({
                                    "type": "thinking",
                                    "subagent_id": current_subagent_task_id,
                                    "content": delta.get("thinking", ""),
                                })
                            elif dtype == "text_delta":
                                await websocket.send_json({
                                    "type": "text",
                                    "subagent_id": current_subagent_task_id,
                                    "content": delta.get("text", ""),
                                })

                elif isinstance(event, AssistantMessage):
                    for block in getattr(event, 'content', []):
                        block_cls = type(block).__name__
                        if block_cls == 'ToolUseBlock':
                            await websocket.send_json({
                                "type": "tool_use",
                                "subagent_id": current_subagent_task_id,
                                "tool": getattr(block, 'name', 'unknown'),
                                "input": getattr(block, 'input', {}),
                            })
                        elif block_cls == 'ThinkingBlock':
                            thinking = getattr(block, 'thinking', '')
                            if thinking:
                                await websocket.send_json({
                                    "type": "thinking",
                                    "subagent_id": current_subagent_task_id,
                                    "content": thinking,
                                })

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
                            await websocket.send_json({
                                "type": "tool_result",
                                "subagent_id": current_subagent_task_id,
                                "output": str(content)[:3000],
                            })

                elif isinstance(event, ResultMessage):
                    result = getattr(event, 'result', '')
                    usage = getattr(event, 'usage', None) or {}
                    cost = getattr(event, 'total_cost_usd', None)
                    await websocket.send_json({
                        "type": "result",
                        "content": result or '',
                        "usage": usage,
                        "cost_usd": cost,
                    })

                elif isinstance(event, TaskStartedMessage):
                    current_subagent_task_id = getattr(event, 'task_id', '')
                    await websocket.send_json({
                        "type": "subagent_started",
                        "task_id": current_subagent_task_id,
                        "description": getattr(event, 'description', ''),
                        "task_type": getattr(event, 'task_type', ''),
                    })

                elif isinstance(event, TaskProgressMessage):
                    await websocket.send_json({
                        "type": "subagent_progress",
                        "task_id": getattr(event, 'task_id', ''),
                        "description": getattr(event, 'description', ''),
                        "last_tool": getattr(event, 'last_tool_name', ''),
                    })

                elif isinstance(event, TaskNotificationMessage):
                    await websocket.send_json({
                        "type": "subagent_done",
                        "task_id": getattr(event, 'task_id', ''),
                        "status": getattr(event, 'status', ''),
                        "summary": getattr(event, 'summary', ''),
                    })
                    current_subagent_task_id = None

                elif isinstance(event, SystemMessage):
                    subtype = getattr(event, 'subtype', '')
                    if subtype == 'init':
                        data = getattr(event, 'data', {})
                        if isinstance(data, dict) and 'session_id' in data:
                            sessions[session_id]["sdk_session_id"] = data["session_id"]

            except Exception:
                continue

        try:
            await websocket.send_json({"type": "done"})
        except Exception:
            pass

    except asyncio.CancelledError:
        # Interrupt the client and disconnect so next query starts fresh
        try:
            await client.interrupt()
        except Exception:
            pass
        # Disconnect client — interrupted state is unreliable for reuse
        session = sessions.get(session_id, {})
        old_client = session.pop("sdk_client", None)
        if old_client:
            try:
                await old_client.disconnect()
            except Exception:
                pass
        try:
            await websocket.send_json({"type": "stopped"})
        except Exception:
            pass
    except Exception as e:
        # On error, disconnect the client so next message creates a fresh one
        session = sessions.get(session_id, {})
        client = session.pop("sdk_client", None)
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass

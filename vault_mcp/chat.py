"""Chat backend — WebSocket bridge to Claude Code subprocess via Agent SDK."""

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from vault_mcp.lib.pages import get_page_content, get_page_metadata

# Active sessions: session_id → state
sessions: dict[str, dict[str, Any]] = {}


async def ws_chat(websocket: WebSocket, vault_root: Path):
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

                prompt = build_prompt(text, context, session_id, vault_root)

                query_task = asyncio.create_task(
                    stream_query(websocket, prompt, session_id, vault_root, context_level)
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
                    # Note: stream_query's CancelledError handler already sends "stopped"

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


def build_prompt(text: str, context: dict, session_id: str, vault_root: Path) -> str:
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


def build_system_prompt(session_id: str, vault_root: Path, context_level: str = "page") -> str:
    """Build system prompt based on context level.

    Levels:
    - page: current file content + parent folder README
    - folder: current folder README (lists children with summaries)
    - global: full master index (titles + summaries for all pages)
    """
    parts = ["""This workspace is a Vault — a unified knowledge base + project workspace.

Structure:
- wiki/ — standalone knowledge articles (each folder has a README.md)
- projects/ — active code repos, paper drafts, experiments
- raw/ — ingested sources, chat transcripts

Vault conventions:
- Pages are folders with README.md. Files are subpages.
- Cross-reference with [[wiki-links]] (e.g. [[Attention Mechanisms]])
- The master index at wiki/meta/index.md catalogs all pages
- When you discover cross-cutting knowledge, suggest adding it to the wiki

You have MCP vault tools available: ripgrep_search, write_index, update_master_index, ingest_url, auto_commit, etc. Use them when helpful.

Responsiveness: If you need to do multi-step work (searching, reading files, running tools), acknowledge first in one line (e.g. "On it — checking the wiki for attention mechanisms") before starting. Without the ack the user is staring at a spinner.

Permissions:
- You may read and write any file inside this vault directory.
- You may run MCP tools freely (search, compile, ingest, index, commit).
- You may run read-only shell commands (ls, find, grep, git status, git log).
- NEVER write or modify files outside the vault directory.
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
        full_path = vault_root / page_path
        if full_path.exists():
            content = get_page_content(full_path)
            if content:
                if len(content) > 8000:
                    content = content[:8000] + "\n\n[... truncated ...]"
                parts.append(f"The user is currently viewing: `{page_path}`\n\n{content}")

            # Also inject parent folder README for local context
            parent = full_path.parent
            if parent != vault_root:
                parent_readme = parent / "README.md"
                if parent_readme.exists():
                    parent_content = get_page_content(parent)
                    if parent_content:
                        parts.append(f"\n--- Parent folder: `{parent.relative_to(vault_root)}` ---\n{parent_content}")

    elif context_level == "folder" and page_path:
        # Inject folder README (which lists children + summaries)
        full_path = vault_root / page_path
        folder = full_path if full_path.is_dir() else full_path.parent
        if folder.exists():
            content = get_page_content(folder)
            folder_rel = str(folder.relative_to(vault_root))
            parts.append(f"The user is browsing folder: `{folder_rel}`\n\n{content}")

    elif context_level == "global":
        # Inject full master index
        index_path = vault_root / "wiki" / "meta" / "index.md"
        if index_path.exists():
            try:
                from vault_mcp.lib.frontmatter import read_frontmatter
                _, index_content = read_frontmatter(index_path)
                parts.append(f"--- Master Index (all vault pages) ---\n{index_content}")
            except Exception:
                pass

    return "\n\n".join(parts)


async def stream_query(websocket: WebSocket, prompt: str, session_id: str, vault_root: Path, context_level: str = "page"):
    """Stream a Claude Code query response to the WebSocket."""
    try:
        from claude_agent_sdk import (
            AssistantMessage,
            ClaudeAgentOptions,
            ResultMessage,
            StreamEvent,
            SystemMessage,
            TaskNotificationMessage,
            TaskProgressMessage,
            TaskStartedMessage,
            UserMessage,
            query,
        )

        mcp_config = vault_root / ".claude" / "mcp.json"
        system_prompt = build_system_prompt(session_id, vault_root, context_level)

        # Use the SDK's session ID for resume (not our browser session ID)
        sdk_sid = sessions.get(session_id, {}).get("sdk_session_id")
        has_run = sessions.get(session_id, {}).get("has_run", False)
        model = sessions.get(session_id, {}).get("model")

        perm_mode = sessions.get(session_id, {}).get("permission_mode", "auto")

        options = ClaudeAgentOptions(
            cwd=str(vault_root),
            system_prompt=system_prompt,
            include_partial_messages=True,
            thinking={"type": "enabled", "budget_tokens": 10000},
            permission_mode=perm_mode,
            resume=sdk_sid if has_run and sdk_sid else None,
            model=model,
        )

        sessions.setdefault(session_id, {})["has_run"] = True

        streamed_text = False
        sent_tool_ids = set()
        current_subagent_task_id = None  # Track which subagent is active

        async for event in query(prompt=prompt, options=options):
            try:
                if isinstance(event, StreamEvent):
                    ev = getattr(event, 'event', None) or {}
                    if isinstance(ev, dict):
                        ev_type = ev.get("type", "")
                        delta = ev.get("delta", {})
                        content_block = ev.get("content_block", {})

                        # Note: content_block_start for tool_use has empty input
                        # We wait for AssistantMessage ToolUseBlock which has the full input

                        # Handle deltas
                        if isinstance(delta, dict):
                            dtype = delta.get("type", "")
                            if dtype == "thinking_delta":
                                await websocket.send_json({
                                    "type": "thinking",
                                    "subagent_id": current_subagent_task_id,
                                    "content": delta.get("thinking", ""),
                                })
                            elif dtype == "text_delta":
                                streamed_text = True
                                await websocket.send_json({
                                    "type": "text",
                                    "subagent_id": current_subagent_task_id,
                                    "content": delta.get("text", ""),
                                })
                            elif dtype == "input_json_delta":
                                # Tool input being streamed — we already sent tool_use on block_start
                                pass

                elif isinstance(event, AssistantMessage):
                    # Full message — only use for tool_use blocks (text already streamed)
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
                        # Skip TextBlock — already sent via text_delta streaming

                elif isinstance(event, UserMessage):
                    # Tool results come as UserMessage with ToolResultBlock content
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
                    if result:
                        await websocket.send_json({"type": "result", "content": result})

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
                    current_subagent_task_id = None  # Back to parent

                elif isinstance(event, SystemMessage):
                    subtype = getattr(event, 'subtype', '')
                    if subtype == 'init':
                        data = getattr(event, 'data', {})
                        if isinstance(data, dict) and 'session_id' in data:
                            sessions[session_id]["sdk_session_id"] = data["session_id"]

            except Exception as send_err:
                continue

        try:
            await websocket.send_json({"type": "done"})
        except Exception:
            pass

    except asyncio.CancelledError:
        try:
            await websocket.send_json({"type": "stopped"})
        except Exception:
            pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass

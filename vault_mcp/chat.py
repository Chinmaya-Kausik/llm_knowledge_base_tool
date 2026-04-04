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
            msg = json.loads(raw)

            if msg["type"] == "init":
                session_id = msg.get("session_id") or str(uuid.uuid4())
                sessions[session_id] = {
                    "page_path": msg.get("page_path"),
                    "history": [],
                }
                await websocket.send_json({"type": "init", "session_id": session_id})

            elif msg["type"] == "message":
                if not session_id:
                    await websocket.send_json({"type": "error", "message": "Not initialized"})
                    continue

                text = msg["text"]
                context = msg.get("context", {})
                context_level = msg.get("context_level", "page")

                # Update session page path if provided
                if context.get("page_path"):
                    sessions[session_id]["page_path"] = context["page_path"]

                # Build prompt with context
                prompt = build_prompt(text, context, session_id, vault_root)

                # Start streaming query in background
                query_task = asyncio.create_task(
                    stream_query(websocket, prompt, session_id, vault_root, context_level)
                )

            elif msg["type"] == "stop":
                # Cancel active generation
                if query_task and not query_task.done():
                    query_task.cancel()
                    await websocket.send_json({"type": "stopped"})

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
    if selection and selection_file:
        parts.append(f'The user has selected this text from `{selection_file}`:\n```\n{selection}\n```\n')

    parts.append(text)
    return "\n".join(parts)


def build_system_prompt(session_id: str, vault_root: Path, context_level: str = "page") -> str:
    """Build system prompt based on context level.

    Levels:
    - page: current file content + parent folder README
    - folder: current folder README (lists children with summaries)
    - global: full master index (titles + summaries for all pages)
    """
    parts = ["You are a helpful assistant for a personal knowledge base vault."]

    session = sessions.get(session_id, {})
    page_path = session.get("page_path")

    if context_level == "page" and page_path:
        # Inject the current page content
        full_path = vault_root / page_path
        if full_path.exists():
            content = get_page_content(full_path)
            if content:
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
            query,
        )

        mcp_config = vault_root / ".claude" / "mcp.json"
        system_prompt = build_system_prompt(session_id, vault_root, context_level)

        options = ClaudeAgentOptions(
            cwd=str(vault_root),
            system_prompt=system_prompt,
            include_partial_messages=True,
            thinking=True,
            permission_mode="auto",
            resume=session_id if session_id in sessions and sessions[session_id].get("has_run") else None,
            session_id=session_id,
        )

        sessions.setdefault(session_id, {})["has_run"] = True

        async for event in query(prompt=prompt, options=options):
            if isinstance(event, StreamEvent):
                # Parse streaming events for partial text and thinking
                ev = event.event if hasattr(event, 'event') else {}
                if isinstance(ev, dict):
                    ev_type = ev.get("type", "")
                    delta = ev.get("delta", {})

                    if delta.get("type") == "thinking_delta":
                        await websocket.send_json({
                            "type": "thinking",
                            "content": delta.get("thinking", ""),
                        })
                    elif delta.get("type") == "text_delta":
                        await websocket.send_json({
                            "type": "text",
                            "content": delta.get("text", ""),
                        })

            elif isinstance(event, AssistantMessage):
                # Full message with content blocks
                for block in getattr(event, 'content', []):
                    if hasattr(block, 'type'):
                        if block.type == 'tool_use':
                            await websocket.send_json({
                                "type": "tool_use",
                                "tool": getattr(block, 'name', 'unknown'),
                                "input": getattr(block, 'input', {}),
                            })
                        elif block.type == 'tool_result':
                            output = getattr(block, 'content', '')
                            if isinstance(output, list):
                                output = ' '.join(str(x) for x in output)
                            await websocket.send_json({
                                "type": "tool_result",
                                "output": str(output)[:2000],
                            })

            elif isinstance(event, ResultMessage):
                # Final result
                result = getattr(event, 'result', '')
                if result:
                    await websocket.send_json({"type": "result", "content": result})

            elif isinstance(event, SystemMessage):
                # System events (init, etc.)
                subtype = getattr(event, 'subtype', '')
                if subtype == 'init':
                    data = getattr(event, 'data', {})
                    if isinstance(data, dict) and 'session_id' in data:
                        sessions[session_id]["sdk_session_id"] = data["session_id"]

        await websocket.send_json({"type": "done"})

    except asyncio.CancelledError:
        await websocket.send_json({"type": "stopped"})
    except Exception as e:
        await websocket.send_json({"type": "error", "message": str(e)})

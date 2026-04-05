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
                # Cancel active generation
                if query_task and not query_task.done():
                    query_task.cancel()
                    await websocket.send_json({"type": "stopped"})

            elif msg_type == "pause_subagent":
                # Pause a specific subagent at its next tool call
                agent_id = msg.get("agent_id", "")
                controller = sessions.get(session_id, {}).get("controller")
                if controller and agent_id:
                    controller.pause_agent(agent_id)
                    await websocket.send_json({"type": "subagent_pausing", "agent_id": agent_id})

            elif msg_type == "resume_subagent":
                # Resume a paused subagent
                agent_id = msg.get("agent_id", "")
                controller = sessions.get(session_id, {}).get("controller")
                if controller and agent_id:
                    controller.resume_agent(agent_id)
                    await websocket.send_json({"type": "subagent_resumed", "agent_id": agent_id})

            elif msg_type == "redirect_subagent":
                # Rollback to checkpoint + cancel subagent + send redirect instructions
                agent_id = msg.get("agent_id", "")
                checkpoint_id = msg.get("checkpoint_id", "")
                instructions = msg.get("instructions", "")
                controller = sessions.get(session_id, {}).get("controller")
                client = sessions.get(session_id, {}).get("client")

                if controller and agent_id:
                    state = controller.agents.get(agent_id)
                    if state:
                        # Find checkpoint
                        target_ckpt = None
                        for ckpt in state.checkpoints:
                            if ckpt.id == checkpoint_id:
                                target_ckpt = ckpt
                                break

                        # Rollback if checkpoint found
                        reverted = []
                        if target_ckpt:
                            reverted = controller.rollback_to_checkpoint(target_ckpt)
                            # Trim checkpoints after this one
                            idx = state.checkpoints.index(target_ckpt)
                            state.checkpoints = state.checkpoints[:idx + 1]

                        # Resume the paused hook with stop signal
                        controller.resume_agent(agent_id, {"continue_": False, "stopReason": "User redirected"})

                        await websocket.send_json({
                            "type": "redirect_started",
                            "agent_id": agent_id,
                            "checkpoint_id": checkpoint_id,
                            "files_reverted": reverted,
                        })

                        # Send redirect as follow-up message to parent
                        if client and instructions:
                            redirect_msg = f"The subagent was stopped and files were reverted. Please try again with these corrected instructions: {instructions}"
                            try:
                                await client.query(redirect_msg)
                            except Exception:
                                pass

            elif msg_type == "stop_subagent":
                # Stop a specific subagent via stop_task
                task_id = msg.get("task_id", "")
                client = sessions.get(session_id, {}).get("client")
                if client and task_id:
                    try:
                        client.stop_task(task_id)
                        await websocket.send_json({"type": "subagent_stopping", "task_id": task_id})
                    except Exception:
                        pass

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

You have MCP vault tools available: ripgrep_search, write_index, update_master_index, ingest_url, auto_commit, etc. Use them when helpful."""]

    session = sessions.get(session_id, {})
    page_path = session.get("page_path")

    if not page_path:
        return parts[0]  # Skip context injection if no page — faster

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
    """Stream a Claude Code query response to the WebSocket using ClaudeSDKClient."""
    try:
        from claude_agent_sdk import (
            AssistantMessage,
            ClaudeAgentOptions,
            ClaudeSDKClient,
            HookMatcher,
            ResultMessage,
            StreamEvent,
            SystemMessage,
            TaskNotificationMessage,
            TaskProgressMessage,
            TaskStartedMessage,
            UserMessage,
        )
        from vault_mcp.subagent_control import SubagentController

        system_prompt = build_system_prompt(session_id, vault_root, context_level)

        sdk_sid = sessions.get(session_id, {}).get("sdk_session_id")
        has_run = sessions.get(session_id, {}).get("has_run", False)
        model = sessions.get(session_id, {}).get("model")

        # Subagent controller with hooks
        controller = SubagentController(vault_root)
        sessions.setdefault(session_id, {})["controller"] = controller

        options = ClaudeAgentOptions(
            cwd=str(vault_root),
            system_prompt=system_prompt,
            include_partial_messages=True,
            thinking={"type": "enabled", "budget_tokens": 10000},
            permission_mode="auto",
            resume=sdk_sid if has_run and sdk_sid else None,
            model=model,
            hooks={
                "PreToolUse": [HookMatcher(matcher=None, hooks=[controller.pre_tool_use_hook], timeout=300)],
                "SubagentStart": [HookMatcher(matcher=None, hooks=[controller.subagent_start_hook])],
                "SubagentStop": [HookMatcher(matcher=None, hooks=[controller.subagent_stop_hook])],
            },
        )

        # Use ClaudeSDKClient for bidirectional control
        client = ClaudeSDKClient(options)
        sessions[session_id]["client"] = client
        sessions[session_id]["has_run"] = True

        streamed_text = False
        sent_tool_ids = set()
        current_subagent_task_id = None

        # Connect and stream
        if has_run and sdk_sid:
            await client.connect()
            await client.query(prompt)
            event_stream = client.receive_response()
        else:
            await client.connect(prompt)
            event_stream = client.receive_messages()

        async for event in event_stream:
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
        finally:
            try:
                await client.disconnect()
            except Exception:
                pass

    except asyncio.CancelledError:
        try:
            client.interrupt()
            await client.disconnect()
        except Exception:
            pass
        try:
            await websocket.send_json({"type": "stopped"})
        except Exception:
            pass
    except Exception as e:
        try:
            await client.disconnect()
        except Exception:
            pass
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass

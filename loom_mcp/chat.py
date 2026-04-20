"""Chat backend — WebSocket bridge to coding agents via adapter layer."""

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
                    "agent_type": msg.get("agent", "claude-code"),
                    "agent_command": msg.get("agent_command"),
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
                # Cancel active generation and wait for cleanup (with timeout
                # so a stuck client.interrupt() doesn't block the WS loop)
                if query_task and not query_task.done():
                    query_task.cancel()
                    task_completed = False
                    try:
                        await asyncio.wait_for(asyncio.shield(query_task), timeout=5.0)
                        task_completed = True
                    except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                        pass
                    query_task = None
                    # Force-send stopped only if the task didn't complete
                    # (it sends its own stopped in the CancelledError handler)
                    if not task_completed:
                        try:
                            await websocket.send_json({"type": "stopped"})
                        except Exception:
                            pass

            elif msg_type == "permission_response":
                # Browser responded to a permission prompt
                if session_id:
                    resolve_permission(session_id, msg.get("decision", "deny"))

            elif msg_type == "set_permissions":
                # Browser sends permission rules: {category: "allow"|"ask"|"deny"}
                if session_id and session_id in sessions:
                    sessions[session_id]["permission_rules"] = msg.get("rules", {})
                    # Disconnect existing adapter so next query uses new rules
                    adapter = sessions[session_id].pop("adapter", None)
                    if adapter:
                        try:
                            await adapter.disconnect()
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
        # Clean up agent adapter on disconnect
        if session_id and session_id in sessions:
            adapter = sessions[session_id].pop("adapter", None)
            if adapter:
                try:
                    await adapter.disconnect()
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


def _load_context_config(loom_root: Path) -> dict:
    """Load context config from loom-local config.yaml, with defaults."""
    defaults = {
        "total_budget_chars": 12000,  # ~3000 tokens total for appended prompt
        "memory": {"enabled": True, "max_chars": 2000},
        "page_content": {"enabled": True, "max_chars": 8000},
        "folder_readme": {"enabled": True},
    }
    config_path = loom_root / "config.yaml"
    if not config_path.exists():
        return defaults
    try:
        import yaml
        with open(config_path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        ctx = data.get("context", {})
        for key in defaults:
            if key in ctx:
                if isinstance(defaults[key], dict):
                    defaults[key].update(ctx[key])
                else:
                    defaults[key] = ctx[key]
        return defaults
    except Exception:
        return defaults


def _read_wiki_file(loom_root: Path, rel_path: str) -> str | None:
    """Read a wiki file's content body (frontmatter stripped), or None."""
    path = loom_root / rel_path
    if not path.exists():
        return None
    try:
        from loom_mcp.lib.frontmatter import read_frontmatter
        _, content = read_frontmatter(path)
        return content.strip() if content else None
    except Exception:
        return None


_DEFAULT_CONVENTIONS = """This workspace is a Loom — a unified knowledge base + project workspace.

Structure:
- wiki/ — standalone knowledge articles (each folder has a ABOUT.md)
- projects/ — active code repos, paper drafts, experiments
- raw/ — ingested sources, chat transcripts

Loom conventions:
- Pages are folders with ABOUT.md. Files are subpages.
- Cross-reference with [[wiki-links]] (e.g. [[Attention Mechanisms]])
- The master index at wiki/meta/index.md catalogs all pages
- When you discover cross-cutting knowledge, suggest adding it to the wiki

You have MCP loom tools available: ripgrep_search, write_index, update_master_index, ingest_url, auto_commit, etc. Use them when helpful."""


def _permissions_block(loom_root: Path) -> str:
    """Safety permissions + responsiveness. Always injected."""
    perm = """Responsiveness: If you need to do multi-step work (searching, reading files, running tools), acknowledge first in one line before starting.

Permissions:
- You may read and write any file inside this loom directory.
- You may run MCP tools freely (search, compile, ingest, index, commit).
- You may run read-only shell commands (ls, find, grep, git status, git log).
- NEVER write or modify files outside the loom directory.
- NEVER modify .claude/ configuration files (mcp.json, settings).
- NEVER run destructive git commands (push, reset --hard, clean -f, branch -D) without explicit user approval.
- NEVER delete files without asking the user first.
- Prefer MCP tools over raw shell commands when both can accomplish the task."""
    # Fallback: if no CLAUDE.md at loom root, also inject default conventions
    if not (loom_root / "CLAUDE.md").exists():
        return _DEFAULT_CONVENTIONS + "\n\n" + perm
    return perm


def _memory_block(loom_root: Path, page_path: str | None, config: dict) -> str | None:
    """Read project MEMORY.md or root MEMORY.md, inject capped."""
    import logging
    log = logging.getLogger("loom.chat")
    if not config.get("memory", {}).get("enabled", True):
        log.info("[memory] disabled by config")
        return None
    max_chars = config.get("memory", {}).get("max_chars", 2000)

    memory_content = None

    # If in a project, try project-level MEMORY.md
    source = None
    if page_path:
        parts = page_path.split("/")
        if len(parts) >= 2 and parts[0] == "projects":
            project_memory = loom_root / "projects" / parts[1] / "MEMORY.md"
            if project_memory.exists():
                try:
                    memory_content = project_memory.read_text(encoding="utf-8").strip()
                    source = f"projects/{parts[1]}/MEMORY.md"
                except Exception:
                    pass

    # Fall back to root MEMORY.md
    if not memory_content:
        root_memory = loom_root / "MEMORY.md"
        if root_memory.exists():
            try:
                memory_content = root_memory.read_text(encoding="utf-8").strip()
                source = "MEMORY.md (root)"
            except Exception:
                pass

    if not memory_content:
        log.info("[memory] no MEMORY.md found for page_path=%s", page_path)
        return None

    if len(memory_content) > max_chars:
        memory_content = memory_content[:max_chars] + "\n\n[... more memories available ...]"

    log.info("[memory] injecting from %s (%d chars) for page_path=%s", source, len(memory_content), page_path)
    return f"What you know about this workspace and user:\n{memory_content}"


def _location_block(loom_root: Path, page_path: str | None, context_level: str, config: dict) -> str | None:
    """Dynamic context: page content, folder README, or master index."""
    if not page_path:
        return None

    page_content_enabled = config.get("page_content", {}).get("enabled", True)
    page_content_max = config.get("page_content", {}).get("max_chars", 8000)
    folder_readme_enabled = config.get("folder_readme", {}).get("enabled", True)

    parts = []

    if context_level == "page":
        full_path = loom_root / page_path
        if full_path.exists() and page_content_enabled:
            content = get_page_content(full_path)
            if content:
                if len(content) > page_content_max:
                    content = content[:page_content_max] + "\n\n[... truncated ...]"
                parts.append(f"The user is currently viewing: `{page_path}`\n\n{content}")

            # Parent folder README for local context
            if folder_readme_enabled:
                parent = full_path.parent
                if parent != loom_root:
                    parent_readme = parent / "ABOUT.md"
                    if parent_readme.exists():
                        parent_content = get_page_content(parent)
                        if parent_content:
                            parts.append(f"\n--- Parent folder: `{parent.relative_to(loom_root)}` ---\n{parent_content}")

    elif context_level == "folder":
        full_path = loom_root / page_path
        folder = full_path if full_path.is_dir() else full_path.parent
        if folder.exists():
            content = get_page_content(folder)
            folder_rel = str(folder.relative_to(loom_root))
            parts.append(f"The user is browsing folder: `{folder_rel}`\n\n{content}")

    elif context_level == "global":
        index_path = loom_root / "wiki" / "meta" / "index.md"
        if index_path.exists():
            try:
                from loom_mcp.lib.frontmatter import read_frontmatter
                _, index_content = read_frontmatter(index_path)
                parts.append(f"--- Master Index (all loom pages) ---\n{index_content}")
            except Exception:
                pass

    return "\n\n".join(parts) if parts else None


def build_system_prompt(session_id: str, loom_root: Path, context_level: str = "page") -> str:
    """Build system prompt from modular context blocks with adaptive budget.

    Assembles blocks in priority order. If total exceeds budget, trims
    lower-priority blocks: page content first, then parent ABOUT.md,
    then memory.

    Levels:
    - page: current file content + parent folder ABOUT.md
    - folder: current folder ABOUT.md (lists children with summaries)
    - global: full master index (titles + summaries for all pages)
    """
    import logging
    log = logging.getLogger("loom.chat")

    config = _load_context_config(loom_root)
    session = sessions.get(session_id, {})
    page_path = session.get("page_path")
    budget = config.get("total_budget_chars", 12000)

    # 1. Permissions — always included, highest priority
    perm = _permissions_block(loom_root)
    used = len(perm)

    # 2. Memory — second priority
    mem = _memory_block(loom_root, page_path, config)
    if mem and used + len(mem) <= budget:
        pass  # fits
    elif mem:
        # Truncate memory to fit
        remaining = max(0, budget - used - 100)
        if remaining > 0:
            mem = mem[:remaining] + "\n[... truncated ...]"
        else:
            mem = None

    if mem:
        used += len(mem)

    # 3. Location — lowest priority, adaptive
    remaining_budget = max(0, budget - used - 50)  # 50 chars for boundary marker
    loc = _location_block_adaptive(loom_root, page_path, context_level, config, remaining_budget)
    if loc:
        used += len(loc)

    # Assemble
    parts = [perm]
    if mem:
        parts.append(mem)
    parts.append("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")
    if loc:
        parts.append(loc)

    total = "\n\n".join(parts)
    log.info("[prompt] total=%d chars (~%d tokens), budget=%d, page_path=%s",
             len(total), len(total) // 4, budget, page_path)
    return total


def _location_block_adaptive(loom_root: Path, page_path: str | None, context_level: str, config: dict, budget: int) -> str | None:
    """Location block with adaptive content injection based on remaining budget."""
    if not page_path:
        return None

    # VM context — page_path starts with "vm:"
    if page_path.startswith("vm:"):
        vm_id = page_path[3:]
        try:
            from loom_mcp.vm.config import get_vm
            vm = get_vm(loom_root, vm_id)
            if vm:
                return (
                    f'The user is currently viewing VM "{vm["label"]}" '
                    f'({vm.get("user", "")}@{vm["host"]}:{vm.get("port", 22)}, '
                    f'working dir: {vm.get("sync_dir", "~")}).\n\n'
                    f"Use vm_* MCP tools (vm_bash, vm_read, vm_write, vm_edit, vm_glob, vm_grep, "
                    f"vm_push, vm_pull, vm_status) to interact with this VM. "
                    f'Pass vm_id="{vm_id}" to all vm_* tools.\n\n'
                    f"Built-in tools (Read, Write, Bash, Glob, Grep, Edit) still operate on "
                    f"the local filesystem — use them for memory, wiki, and local files."
                )
            else:
                return f'The user is viewing a VM with id "{vm_id}" (not found in config).'
        except ImportError:
            return f'The user is viewing VM "{vm_id}" (VM module not available).'

    parts = []

    if context_level == "page":
        full_path = loom_root / page_path
        if full_path.exists() and config.get("page_content", {}).get("enabled", True):
            content = get_page_content(full_path)
            if content:
                if len(content) <= 2000:
                    # Small file: inject full content
                    parts.append(f"The user is currently viewing: `{page_path}`\n\n{content}")
                elif len(content) <= budget - 200:
                    # Medium file: inject truncated to budget
                    max_chars = min(len(content), budget - 200)
                    parts.append(f"The user is currently viewing: `{page_path}`\n\n{content[:max_chars]}\n\n[... truncated ...]")
                else:
                    # Large file: just the path, Claude reads on demand
                    parts.append(f"The user is currently viewing: `{page_path}` (large file — read on demand)")
            else:
                parts.append(f"The user is currently viewing: `{page_path}`")

            # Parent folder ABOUT.md — only if budget allows
            if config.get("folder_readme", {}).get("enabled", True):
                current_size = sum(len(p) for p in parts)
                if current_size < budget - 500:
                    parent = full_path.parent
                    if parent != loom_root:
                        parent_about = parent / "ABOUT.md"
                        if parent_about.exists():
                            parent_content = get_page_content(parent)
                            if parent_content:
                                remaining = budget - current_size - 50
                                if len(parent_content) <= remaining:
                                    parts.append(f"\n--- Parent folder: `{parent.relative_to(loom_root)}` ---\n{parent_content}")
                                # else: skip parent, not enough budget

    elif context_level == "folder":
        full_path = loom_root / page_path
        folder = full_path if full_path.is_dir() else full_path.parent
        if folder.exists():
            content = get_page_content(folder)
            if content:
                if len(content) > budget:
                    content = content[:budget - 50] + "\n\n[... truncated ...]"
                folder_rel = str(folder.relative_to(loom_root))
                parts.append(f"The user is browsing folder: `{folder_rel}`\n\n{content}")

    elif context_level == "global":
        index_path = loom_root / "wiki" / "meta" / "index.md"
        if index_path.exists():
            try:
                from loom_mcp.lib.frontmatter import read_frontmatter
                _, index_content = read_frontmatter(index_path)
                if len(index_content) > budget:
                    index_content = index_content[:budget - 50] + "\n\n[... truncated ...]"
                parts.append(f"--- Master Index (all loom pages) ---\n{index_content}")
            except Exception:
                pass

    return "\n\n".join(parts) if parts else None


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


async def _get_or_create_adapter(session_id: str, loom_root: Path, context_level: str, websocket: WebSocket):
    """Get an existing agent adapter for the session, or create a new one."""
    from loom_mcp.agents import AgentAdapter, get_adapter

    session = sessions.get(session_id, {})
    adapter = session.get("adapter")

    if adapter is not None:
        return adapter

    agent_type = session.get("agent_type", "claude-code")
    system_prompt = build_system_prompt(session_id, loom_root, context_level)
    model = session.get("model")
    rules = session.get("permission_rules", {})

    # Build adapter config
    config: dict = {
        "session_id": session_id,
        "loom_root": str(loom_root),
        "system_prompt": system_prompt,
        "model": model,
    }
    # Custom agent command (for generic-cli adapter)
    agent_command = session.get("agent_command")
    if agent_command:
        config["command"] = agent_command

    if agent_type == "claude-code":
        # Claude-specific config
        has_rules = any(v != "allow" for v in rules.values())
        config["permission_mode"] = "default" if has_rules else "auto"
        config["can_use_tool"] = _make_permission_handler(session_id, websocket) if has_rules else None
        config["resume_session_id"] = session.get("sdk_session_id")
        config["has_run"] = session.get("has_run", False)

        # PreCompact hook
        from claude_agent_sdk.types import HookMatcher, SyncHookJSONOutput

        async def _on_precompact(hook_input, matcher, context):
            import logging
            log = logging.getLogger("loom.chat")
            panel = sessions.get(session_id, {})
            messages = panel.get("messages_snapshot", [])
            if not messages:
                return SyncHookJSONOutput(exit_code=0)
            chats_dir = loom_root / "raw" / "chats"
            chats_dir.mkdir(parents=True, exist_ok=True)
            compact_count = panel.get("compact_count", 0) + 1
            panel["compact_count"] = compact_count
            filename = f"{session_id[:8]}_precompact_{compact_count}.md"
            path = chats_dir / filename
            from loom_mcp.tools.compile import _render_messages
            lines = [f"# Pre-compaction snapshot {compact_count}", f"Session: {session_id}", ""]
            lines.extend(_render_messages(messages))
            path.write_text("\n".join(lines), encoding="utf-8")
            precompacts = panel.setdefault("precompact_files", [])
            precompacts.append(str(path.relative_to(loom_root)))
            log.info("[compact] Saved %d messages to %s (compaction #%d)", len(messages), filename, compact_count)
            return SyncHookJSONOutput(exit_code=0)

        config["hooks"] = {"PreCompact": [HookMatcher(hooks=[_on_precompact])]}
    else:
        # Non-Claude agents: pass agent-specific config from app config
        try:
            import json as _json
            app_config_path = Path.home() / ".loom-app-config.json"
            if app_config_path.exists():
                app_config = _json.loads(app_config_path.read_text())
                agent_cfg = app_config.get("agents", {}).get(agent_type, {})
                config.update(agent_cfg)
        except Exception:
            pass

    adapter = get_adapter(agent_type)
    await adapter.connect(config)
    session["adapter"] = adapter
    session["has_run"] = True
    return adapter


async def stream_query(websocket: WebSocket, prompt: str, session_id: str, loom_root: Path, context_level: str = "page"):
    """Stream an agent query response to the WebSocket.

    Agent-agnostic: consumes AgentEvents from the adapter and forwards
    them to the browser using the same WebSocket protocol.
    """
    adapter = None
    try:
        from loom_mcp.agents import AgentEvent

        adapter = await _get_or_create_adapter(session_id, loom_root, context_level, websocket)

        # Track messages for PreCompact snapshot
        session = sessions.get(session_id, {})
        msg_snapshot = session.setdefault("messages_snapshot", [])
        msg_snapshot.append({"role": "user", "content": prompt})

        await adapter.query(prompt)

        async for event in adapter.receive():
            try:
                if event.type == "text":
                    await websocket.send_json({
                        "type": "text",
                        "subagent_id": event.data.get("subagent_id"),
                        "content": event.content,
                    })
                elif event.type == "thinking":
                    await websocket.send_json({
                        "type": "thinking",
                        "subagent_id": event.data.get("subagent_id"),
                        "content": event.content,
                    })
                elif event.type == "tool_use":
                    await websocket.send_json({
                        "type": "tool_use",
                        "subagent_id": event.data.get("subagent_id"),
                        "tool": event.data.get("tool", "unknown"),
                        "input": event.data.get("input", {}),
                    })
                elif event.type == "tool_result":
                    await websocket.send_json({
                        "type": "tool_result",
                        "subagent_id": event.data.get("subagent_id"),
                        "output": event.content,
                    })
                elif event.type == "result":
                    if event.content:
                        msg_snapshot.append({"role": "assistant", "content": event.content})
                    await websocket.send_json({
                        "type": "result",
                        "content": event.content,
                        "usage": event.data.get("usage", {}),
                        "cost_usd": event.data.get("cost_usd"),
                    })
                elif event.type == "subagent_started":
                    await websocket.send_json({
                        "type": "subagent_started",
                        "task_id": event.data.get("task_id", ""),
                        "description": event.data.get("description", ""),
                        "task_type": event.data.get("task_type", ""),
                    })
                elif event.type == "subagent_progress":
                    await websocket.send_json({
                        "type": "subagent_progress",
                        "task_id": event.data.get("task_id", ""),
                        "description": event.data.get("description", ""),
                        "last_tool": event.data.get("last_tool", ""),
                    })
                elif event.type == "subagent_done":
                    await websocket.send_json({
                        "type": "subagent_done",
                        "task_id": event.data.get("task_id", ""),
                        "status": event.data.get("status", ""),
                        "summary": event.data.get("summary", ""),
                    })
                elif event.type == "init":
                    # Store SDK session ID for resume support
                    sdk_sid = event.data.get("sdk_session_id")
                    if sdk_sid:
                        sessions[session_id]["sdk_session_id"] = sdk_sid
                elif event.type == "error":
                    await websocket.send_json({"type": "error", "message": event.content})
            except Exception:
                continue

        try:
            await websocket.send_json({"type": "done"})
        except Exception:
            pass

        # Send ntfy notification on completion
        try:
            from loom_mcp.notify import notify_agent_done
            session = sessions.get(session_id, {})
            agent_type = session.get("agent_type", "claude-code")
            # Get last result content for summary
            last_result = ""
            for msg in reversed(session.get("messages_snapshot", [])):
                if msg.get("role") == "assistant":
                    last_result = msg.get("content", "")[:200]
                    break
            notify_agent_done(agent_type, last_result)
        except Exception:
            pass

    except asyncio.CancelledError:
        # Interrupt and disconnect so next query starts fresh
        if adapter:
            await adapter.stop()
        session = sessions.get(session_id, {})
        old_adapter = session.pop("adapter", None)
        if old_adapter:
            await old_adapter.disconnect()
        try:
            await websocket.send_json({"type": "stopped"})
        except Exception:
            pass
    except Exception as e:
        # On error, disconnect the adapter so next message creates a fresh one
        session = sessions.get(session_id, {})
        old_adapter = session.pop("adapter", None)
        if old_adapter:
            try:
                await old_adapter.disconnect()
            except Exception:
                pass
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass

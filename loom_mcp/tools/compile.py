"""Compilation support tools — hash checking, frontmatter management, registry updates."""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loom_mcp.lib.frontmatter import read_frontmatter, write_frontmatter
from loom_mcp.lib.hashing import content_hash
from loom_mcp.lib.registry import add_page, load_registry, save_registry


def get_changed_sources(loom_root: Path) -> list[dict]:
    """Scan raw/ for files needing compilation.

    Returns files where compiled=false or where content hash has changed.
    Each item: {path, content_hash, old_hash, status}
    Status is "new" (never compiled) or "modified" (hash changed).
    """
    raw_dir = loom_root / "raw"
    changed = []

    for md_file in raw_dir.rglob("*.md"):
        try:
            metadata, content = read_frontmatter(md_file)
        except Exception:
            continue

        current_hash = content_hash(content)
        old_hash = metadata.get("content_hash", "")
        compiled = metadata.get("compiled", False)

        if not compiled:
            changed.append({
                "path": str(md_file.relative_to(loom_root)),
                "content_hash": current_hash,
                "old_hash": old_hash,
                "status": "new",
            })
        elif current_hash != old_hash:
            changed.append({
                "path": str(md_file.relative_to(loom_root)),
                "content_hash": current_hash,
                "old_hash": old_hash,
                "status": "modified",
            })

    return changed


def get_page_registry(loom_root: Path) -> dict:
    """Read wiki/meta/page-registry.json."""
    registry_path = loom_root / "wiki" / "meta" / "page-registry.json"
    return load_registry(registry_path)


def get_glossary(loom_root: Path) -> str:
    """Read wiki/meta/glossary.md content."""
    glossary_path = loom_root / "wiki" / "meta" / "glossary.md"
    if not glossary_path.exists():
        return ""
    _, content = read_frontmatter(glossary_path)
    return content


def _validate_path(loom_root: Path, path: str) -> Path:
    """Resolve a path and ensure it stays within the loom root."""
    full_path = (loom_root / path).resolve()
    if not str(full_path).startswith(str(loom_root.resolve()) + "/") and full_path != loom_root.resolve():
        raise ValueError(f"Path traversal blocked: {path}")
    return full_path


def read_source(loom_root: Path, path: str) -> dict:
    """Read a raw source file, returning frontmatter and content.

    Args:
        path: Relative path from loom root.

    Returns: {frontmatter: dict, content: str}
    """
    full_path = _validate_path(loom_root, path)
    if not full_path.exists():
        raise FileNotFoundError(f"Source not found: {path}")
    metadata, content = read_frontmatter(full_path)
    return {"frontmatter": metadata, "content": content}


def read_wiki_page(loom_root: Path, path: str) -> dict:
    """Read a wiki page, returning frontmatter and content.

    Args:
        path: Relative path from loom root.

    Returns: {frontmatter: dict, content: str}
    """
    full_path = _validate_path(loom_root, path)
    if not full_path.exists():
        raise FileNotFoundError(f"Wiki page not found: {path}")
    metadata, content = read_frontmatter(full_path)
    return {"frontmatter": metadata, "content": content}


def write_wiki_page(
    loom_root: Path,
    path: str,
    page_frontmatter: dict[str, Any],
    content: str,
) -> dict:
    """Write a wiki page with validated frontmatter.

    Auto-updates page-registry.json if it's a new page.

    Args:
        path: Relative path from loom root (e.g., "wiki/pages/transformers.md").
        page_frontmatter: Complete frontmatter dict.
        content: Markdown content body.

    Returns: {path, title, is_new}
    """
    full_path = _validate_path(loom_root, path)
    registry_path = loom_root / "wiki" / "meta" / "page-registry.json"

    # Write the page
    write_frontmatter(full_path, page_frontmatter, content)

    # Update registry
    registry = load_registry(registry_path)
    title = page_frontmatter.get("title", full_path.stem)
    aliases = page_frontmatter.get("aliases", [])

    # Check if page already exists in registry
    is_new = not any(p["path"] == path for p in registry["pages"])

    registry = add_page(registry, title, path, aliases)
    save_registry(registry_path, registry)

    return {"path": path, "title": title, "is_new": is_new}


def mark_source_compiled(loom_root: Path, path: str, hash_value: str) -> dict:
    """Update compiled=true and content_hash in a raw source's frontmatter.

    Args:
        path: Relative path from loom root.
        hash_value: The current content hash.

    Returns: {path, hash}
    """
    full_path = loom_root / path
    if not full_path.exists():
        raise FileNotFoundError(f"Source not found: {path}")

    metadata, content = read_frontmatter(full_path)
    metadata["compiled"] = True
    metadata["content_hash"] = hash_value
    write_frontmatter(full_path, metadata, content)

    return {"path": path, "hash": hash_value}


def update_glossary(loom_root: Path, term: str, definition: str) -> dict:
    """Append a term to wiki/meta/glossary.md.

    Args:
        term: The canonical term.
        definition: The definition text.

    Returns: {term, added}
    """
    glossary_path = loom_root / "wiki" / "meta" / "glossary.md"

    if glossary_path.exists():
        metadata, content = read_frontmatter(glossary_path)
    else:
        metadata = {
            "title": "Glossary",
            "type": "structure-note",
            "status": "compiled",
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "last_compiled": datetime.now(timezone.utc).isoformat(),
        }
        content = "# Glossary\n\nCanonical terms for the knowledge base.\n"

    # Check if term already exists
    if f"## {term}" in content:
        return {"term": term, "added": False}

    content = content.rstrip() + f"\n\n## {term}\n\n{definition}\n"
    metadata["last_compiled"] = datetime.now(timezone.utc).isoformat()
    write_frontmatter(glossary_path, metadata, content)

    return {"term": term, "added": True}


def append_log(loom_root: Path, entry_type: str, title: str, details: str = "") -> dict:
    """Append an entry to wiki/meta/log.md.

    Creates a grep-friendly chronological log of all operations.
    Format: ## [YYYY-MM-DD] type | title

    Args:
        entry_type: Operation type (e.g., "ingest", "compile", "query", "lint", "file-answer").
        title: Short description of what happened.
        details: Optional additional details.

    Returns: {timestamp, entry_type, title}
    """
    log_path = loom_root / "wiki" / "meta" / "log.md"
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M")

    entry = f"## [{date_str}] {entry_type} | {title}\n"
    if details:
        entry += f"\n{details}\n"
    entry += "\n"

    if log_path.exists():
        existing = log_path.read_text(encoding="utf-8")
    else:
        existing = "# Operation Log\n\nChronological record of all loom operations.\n\n"

    existing += entry
    log_path.write_text(existing, encoding="utf-8")

    return {"timestamp": now.isoformat(), "entry_type": entry_type, "title": title}


def update_master_index(loom_root: Path) -> dict:
    """Regenerate wiki/meta/index.md — a master catalog of ALL wiki pages.

    Each page is listed with a link, one-line summary (from the first paragraph),
    type, and status. Organized by category. The LLM reads this first when
    answering queries to find relevant pages.

    Returns: {total_pages, categories}
    """
    wiki_dir = loom_root / "wiki"
    registry_path = wiki_dir / "meta" / "page-registry.json"
    registry = load_registry(registry_path)

    # Collect page info grouped by type
    categories: dict[str, list[dict]] = {}
    for page in registry.get("pages", []):
        full_path = loom_root / page["path"]
        if not full_path.exists():
            continue

        try:
            metadata, content = read_frontmatter(full_path)
        except Exception:
            continue

        page_type = metadata.get("type", "unknown")
        title = metadata.get("title", full_path.stem)
        status = metadata.get("status", "unknown")
        tags = metadata.get("tags", [])

        # Extract first non-heading, non-empty paragraph as summary
        summary = ""
        for line in content.split("\n"):
            line = line.strip()
            if line and not line.startswith("#") and not line.startswith("---"):
                summary = line[:120]
                if len(line) > 120:
                    summary += "..."
                break

        if page_type not in categories:
            categories[page_type] = []
        categories[page_type].append({
            "title": title,
            "path": page["path"],
            "summary": summary,
            "status": status,
            "tags": tags,
        })

    # Build the index content
    now = datetime.now(timezone.utc)
    lines = [
        "# Master Index",
        "",
        f"Auto-generated catalog of all {sum(len(v) for v in categories.values())} wiki pages.",
        f"Last updated: {now.strftime('%Y-%m-%d %H:%M')} UTC",
        "",
    ]

    # Sort categories in a sensible order
    category_order = ["concept", "summary", "index", "answer", "structure-note", "unknown"]
    sorted_cats = sorted(categories.keys(), key=lambda c: (category_order.index(c) if c in category_order else 99, c))

    for cat in sorted_cats:
        pages = categories[cat]
        lines.append(f"## {cat.title()}s ({len(pages)})")
        lines.append("")
        for p in sorted(pages, key=lambda x: x["title"]):
            tag_str = f" [{', '.join(p['tags'])}]" if p["tags"] else ""
            lines.append(f"- **[[{p['title']}]]** — {p['summary']}{tag_str}")
        lines.append("")

    content = "\n".join(lines)

    # Write the index
    index_path = wiki_dir / "meta" / "index.md"
    index_metadata = {
        "title": "Master Index",
        "type": "structure-note",
        "status": "compiled",
        "created": now.strftime("%Y-%m-%d"),
        "last_compiled": now.isoformat(),
    }

    # Preserve original created date
    if index_path.exists():
        try:
            old_meta, _ = read_frontmatter(index_path)
            index_metadata["created"] = old_meta.get("created", index_metadata["created"])
        except Exception:
            pass

    write_frontmatter(index_path, index_metadata, content)

    return {
        "total_pages": sum(len(v) for v in categories.values()),
        "categories": {k: len(v) for k, v in categories.items()},
    }


def detect_changes(loom_root: Path, since: str = "HEAD~1") -> list[dict]:
    """Detect changed files using git diff.

    Args:
        since: Git ref to compare against (default: last commit).

    Returns: [{path, status}] where status is "added", "modified", or "deleted".
    """
    import subprocess

    result = subprocess.run(
        ["git", "diff", "--name-status", since],
        cwd=str(loom_root), capture_output=True, text=True,
    )
    if result.returncode != 0:
        # Fallback: if git fails, return empty (first commit, etc.)
        return []

    changes = []
    status_map = {"A": "added", "M": "modified", "D": "deleted"}
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        parts = line.split("\t", 1)
        if len(parts) == 2:
            status_code, filepath = parts
            changes.append({
                "path": filepath,
                "status": status_map.get(status_code[0], "modified"),
            })

    return changes


def get_stale_readmes(loom_root: Path) -> list[dict]:
    """Find folders whose contents changed but README hasn't been updated.

    Compares content hashes of folder children against the README's last_compiled timestamp.
    Returns: [{folder, readme_path, changed_files}]
    """
    from loom_mcp.lib.pages import walk_pages, is_hidden

    stale = []

    for item in loom_root.rglob("*"):
        if not item.is_dir() or is_hidden(item):
            continue

        readme = item / "ABOUT.md"
        if not readme.exists():
            # Folder without README — it's "stale" (needs one)
            children = [f.name for f in item.iterdir() if not is_hidden(f) and f.name != "ABOUT.md"]
            if children:
                stale.append({
                    "folder": str(item.relative_to(loom_root)),
                    "readme_path": None,
                    "reason": "missing",
                    "changed_files": children[:10],
                })
            continue

        # Check if README is older than any child file
        try:
            readme_mtime = readme.stat().st_mtime
        except OSError:
            continue

        changed = []
        for child in item.iterdir():
            if child.name == "ABOUT.md" or is_hidden(child):
                continue
            try:
                if child.stat().st_mtime > readme_mtime:
                    changed.append(child.name)
            except OSError:
                continue

        if changed:
            stale.append({
                "folder": str(item.relative_to(loom_root)),
                "readme_path": str(readme.relative_to(loom_root)),
                "reason": "outdated",
                "changed_files": changed[:10],
            })

    return stale


def _derive_chat_tags(context_path: str | None) -> list[str]:
    """Derive tags for a chat transcript from its context path."""
    if not context_path:
        return []
    parts = context_path.split("/")
    if len(parts) >= 2 and parts[0] == "projects":
        return [parts[1]]
    return []


def save_chat_transcript(loom_root: Path, session_id: str, messages: list[dict], title: str | None = None, context_path: str | None = None, precompact_files: list[str] | None = None) -> dict:
    """Save a chat transcript to raw/chats/ with frontmatter and collapsible sections.

    Args:
        session_id: Chat session ID.
        messages: List of {role, content, subagent_id?} message dicts.
        title: Optional LLM-generated title. If provided, used as heading.
        context_path: Page/folder path the chat was associated with.
        precompact_files: List of pre-compaction snapshot file paths (for Continue).

    Returns: {path, message_count}
    """
    chats_dir = loom_root / "raw" / "chats"
    chats_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now()  # Local timezone
    # Name file from first user message (slugified)
    first_msg = next((m.get("content", "") for m in messages if m.get("role") == "user"), "")
    slug = first_msg[:40].strip().lower()
    slug = "".join(c if c.isalnum() or c == ' ' else '' for c in slug).strip().replace(' ', '-')
    slug = slug or session_id[:8]
    filename = f"{slug}_{now.strftime('%Y-%m-%d_%H%M')}.md"
    path = chats_dir / filename

    heading = title or f"Chat — {now.strftime('%Y-%m-%d %H:%M')}"
    tags = _derive_chat_tags(context_path)

    metadata = {
        "title": heading,
        "type": "chat",
        "saved": now.strftime("%Y-%m-%d"),
        "session_id": session_id,
    }
    if tags:
        metadata["tags"] = tags
    if context_path:
        metadata["context_path"] = context_path
    if precompact_files:
        metadata["precompact_files"] = precompact_files

    content_lines = [f"Session: {session_id}", ""]
    content_lines.extend(_render_messages(messages))

    from loom_mcp.lib.frontmatter import write_frontmatter
    write_frontmatter(path, metadata, "\n".join(content_lines))

    return {
        "path": str(path.relative_to(loom_root)),
        "message_count": len(messages),
    }


def _render_messages(messages: list[dict]) -> list[str]:
    """Render a list of chat messages into markdown lines."""
    lines: list[str] = []

    # Group consecutive thinking/tool/tool_result messages into activity blocks
    i = 0
    while i < len(messages):
        msg = messages[i]
        role = msg.get("role", "unknown")
        content = msg.get("content", "")
        subagent_id = msg.get("subagent_id")

        if role == "user":
            lines.append("## You")
            lines.append("")
            lines.append(content)
            lines.append("")
            i += 1

        elif role == "assistant":
            lines.append("## Claude")
            lines.append("")
            lines.append(content)
            lines.append("")
            i += 1

        elif role == "thinking":
            # Collect consecutive thinking blocks (same subagent)
            thinking_parts = []
            while i < len(messages) and messages[i].get("role") == "thinking" and messages[i].get("subagent_id") == subagent_id:
                thinking_parts.append(messages[i].get("content", ""))
                i += 1
            full_thinking = "".join(thinking_parts)
            lines.append("<details>")
            lines.append("<summary>Thought</summary>")
            lines.append("")
            lines.append(full_thinking)
            lines.append("")
            lines.append("</details>")
            lines.append("")

        elif role == "tool":
            # Collect consecutive tool/tool_result pairs into an activity group
            tool_counts: dict[str, int] = {}
            tool_lines: list[str] = []
            while i < len(messages) and messages[i].get("role") in ("tool", "tool_result") and messages[i].get("subagent_id") == subagent_id:
                m = messages[i]
                if m["role"] == "tool":
                    tool_content = m.get("content", "")
                    # Parse "ToolName: description" format
                    if ": " in tool_content:
                        tname, tdesc = tool_content.split(": ", 1)
                    else:
                        tname, tdesc = tool_content, ""
                    tool_counts[tname] = tool_counts.get(tname, 0) + 1
                    tool_lines.append(f"- **{tname}** — {tdesc}")
                    # Check if next message is the result
                    if i + 1 < len(messages) and messages[i + 1].get("role") == "tool_result":
                        i += 1
                        result = messages[i].get("content", "")
                        if result:
                            tool_lines.append(f"  - {result}")
                i += 1

            # Build summary like "Read 3 files, ran 2 commands"
            summary_parts = _summarize_tools(tool_counts)
            summary = ", ".join(summary_parts) if summary_parts else "Activity"

            lines.append("<details>")
            lines.append(f"<summary>{summary}</summary>")
            lines.append("")
            lines.extend(tool_lines)
            lines.append("")
            lines.append("</details>")
            lines.append("")

        elif role == "tool_result":
            # Orphaned tool_result (no preceding tool) — just emit it
            lines.append(f"  - {content}")
            i += 1

        elif role == "subagent":
            if content.startswith("Started:"):
                desc = content[len("Started:"):].strip()
                # Collect messages belonging to this subagent until "Done" or a boundary
                subagent_lines: list[str] = []
                i += 1
                done_status = ""
                while i < len(messages):
                    m = messages[i]
                    mr = m.get("role", "")
                    mc = m.get("content", "")
                    # Stop at Done for this subagent
                    if mr == "subagent" and mc.startswith("Done"):
                        done_status = mc
                        i += 1
                        break
                    # Stop at boundaries: new subagent, user, assistant
                    if mr in ("user", "assistant") or (mr == "subagent" and mc.startswith("Started:")):
                        break
                    # Render inner messages (thinking/tool/tool_result)
                    if mr == "thinking":
                        subagent_lines.append(f"> {mc[:500]}{'...' if len(mc) > 500 else ''}")
                    elif mr == "tool":
                        if ": " in mc:
                            tname, tdesc = mc.split(": ", 1)
                        else:
                            tname, tdesc = mc, ""
                        subagent_lines.append(f"- **{tname}** — {tdesc}")
                    elif mr == "tool_result":
                        if mc:
                            subagent_lines.append(f"  - {mc}")
                    i += 1

                status = ""
                if "completed" in done_status:
                    status = " — completed"
                elif "failed" in done_status:
                    status = " — failed"

                lines.append("<details>")
                lines.append(f"<summary>Agent: {desc}{status}</summary>")
                lines.append("")
                lines.extend(subagent_lines)
                lines.append("")
                lines.append("</details>")
                lines.append("")
            else:
                # "Done" without matching "Started" — emit as-is
                lines.append(f"*{content}*")
                lines.append("")
                i += 1
        elif role == "plan":
            status = msg.get("status", "")
            label = "Plan" + (f" — {status}" if status else "")
            lines.append("<details>")
            lines.append(f"<summary>{label}</summary>")
            lines.append("")
            lines.append(content)
            lines.append("")
            lines.append("</details>")
            lines.append("")
            i += 1

        else:
            lines.append(f"## {role.title()}")
            lines.append("")
            lines.append(content)
            lines.append("")
            i += 1

    return lines


def _summarize_tools(tool_counts: dict[str, int]) -> list[str]:
    """Build human-readable summary from tool counts, e.g. 'Read 3 files, ran 2 commands'."""
    summaries = []
    friendly = {
        "Read": ("Read", "file"),
        "Bash": ("Ran", "command"),
        "Grep": ("Searched", "pattern"),
        "Glob": ("Found", "pattern"),
        "Edit": ("Edited", "file"),
        "Write": ("Wrote", "file"),
        "Agent": ("Spawned", "agent"),
    }
    for tool, count in tool_counts.items():
        if tool in friendly:
            verb, noun = friendly[tool]
            summaries.append(f"{verb} {count} {noun}{'s' if count != 1 else ''}")
        else:
            summaries.append(f"{tool} x{count}" if count > 1 else tool)
    return summaries

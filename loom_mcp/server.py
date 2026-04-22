"""MCP server entrypoint — stdio transport, registers all loom tools."""

import json
import os
from pathlib import Path


def _shell_escape(s: str) -> str:
    """Escape a string for safe use in shell commands."""
    return "'" + s.replace("'", "'\\''") + "'"

from mcp.server.fastmcp import FastMCP

# Resolve loom root: env var > config file > default
def _resolve_loom_root() -> Path:
    if "LOOM_ROOT" in os.environ:
        return Path(os.environ["LOOM_ROOT"])
    config = Path.home() / ".loom-app-config.json"
    if config.exists():
        try:
            import json as _json
            data = _json.loads(config.read_text())
            if data.get("loom_root"):
                return Path(data["loom_root"])
        except Exception:
            pass
    return Path.home() / "Documents" / "loom"

LOOM_ROOT = _resolve_loom_root()

mcp = FastMCP("loom", instructions="Personal knowledge base tools. All tools are deterministic — no LLM calls.")


def _bootstrap_loom(loom_root: Path) -> None:
    """Create the loom directory structure if it doesn't exist."""
    for d in ["raw/inbox", "raw/articles", "raw/papers", "raw/repos", "raw/media",
              "wiki/pages", "wiki/meta", "wiki/meta/indexes",
              "wiki/meta/memory",
              "outputs/slides", "outputs/reports", "outputs/visualizations"]:
        (loom_root / d).mkdir(parents=True, exist_ok=True)
    reg = loom_root / "wiki" / "meta" / "page-registry.json"
    if not reg.exists():
        reg.write_text('{"pages": []}', encoding="utf-8")


_bootstrap_loom(LOOM_ROOT)


# --- Ingestion Tools ---

@mcp.tool()
def ingest_url(url: str) -> str:
    """Fetch a URL via trafilatura and write to raw/inbox/ with frontmatter.

    Returns JSON: {path, title, content_hash}
    """
    from loom_mcp.tools.ingest import ingest_url as _ingest_url
    result = _ingest_url(LOOM_ROOT, url)
    return json.dumps(result, indent=2)


@mcp.tool()
def ingest_pdf(filepath: str) -> str:
    """Extract PDF to markdown via PyMuPDF4LLM and write to raw/inbox/.

    Returns JSON: {path, title, content_hash}
    """
    from loom_mcp.tools.ingest import ingest_pdf as _ingest_pdf
    result = _ingest_pdf(LOOM_ROOT, filepath)
    return json.dumps(result, indent=2)


@mcp.tool()
def ingest_text(text: str, title: str) -> str:
    """Write raw text to raw/inbox/ with frontmatter.

    Returns JSON: {path, content_hash}
    """
    from loom_mcp.tools.ingest import ingest_text as _ingest_text
    result = _ingest_text(LOOM_ROOT, text, title)
    return json.dumps(result, indent=2)


@mcp.tool()
def classify_inbox_item(source: str, destination: str) -> str:
    """Move a file from raw/inbox/ to the appropriate raw/ subdirectory.

    Args:
        source: Relative path (e.g., "raw/inbox/foo.md")
        destination: Relative path (e.g., "raw/articles/foo.md")

    Returns JSON: {old_path, new_path}
    """
    from loom_mcp.tools.ingest import classify_inbox_item as _classify
    result = _classify(LOOM_ROOT, source, destination)
    return json.dumps(result, indent=2)


# --- Compilation Tools ---

@mcp.tool()
def get_changed_sources() -> str:
    """Scan raw/ for files needing compilation (uncompiled or modified).

    Returns JSON: [{path, content_hash, old_hash, status}]
    """
    from loom_mcp.tools.compile import get_changed_sources as _get_changed
    result = _get_changed(LOOM_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def get_page_registry() -> str:
    """Read wiki/meta/page-registry.json.

    Returns JSON: {pages: [{title, path, aliases}]}
    """
    from loom_mcp.tools.compile import get_page_registry as _get_registry
    result = _get_registry(LOOM_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def get_glossary() -> str:
    """Read wiki/meta/glossary.md content."""
    from loom_mcp.tools.compile import get_glossary as _get_glossary
    return _get_glossary(LOOM_ROOT)


@mcp.tool()
def read_source(path: str) -> str:
    """Read a raw source file. Path is relative to loom root.

    Returns JSON: {frontmatter, content}
    """
    from loom_mcp.tools.compile import read_source as _read_source
    result = _read_source(LOOM_ROOT, path)
    # Serialize frontmatter (may contain datetime objects)
    result["frontmatter"] = _serialize_frontmatter(result["frontmatter"])
    return json.dumps(result, indent=2)


@mcp.tool()
def read_wiki_page(path: str) -> str:
    """Read a wiki page. Path is relative to loom root.

    Returns JSON: {frontmatter, content}
    """
    from loom_mcp.tools.compile import read_wiki_page as _read_wiki
    result = _read_wiki(LOOM_ROOT, path)
    result["frontmatter"] = _serialize_frontmatter(result["frontmatter"])
    return json.dumps(result, indent=2)


@mcp.tool()
def write_wiki_page(path: str, frontmatter_json: str, content: str) -> str:
    """Write a wiki page with frontmatter.

    Args:
        path: Relative path (e.g., "wiki/pages/transformers.md")
        frontmatter_json: JSON string of frontmatter dict
        content: Markdown content body

    Returns JSON: {path, title, is_new}
    """
    from loom_mcp.tools.compile import write_wiki_page as _write_wiki
    page_frontmatter = json.loads(frontmatter_json)
    result = _write_wiki(LOOM_ROOT, path, page_frontmatter, content)
    return json.dumps(result, indent=2)


@mcp.tool()
def mark_source_compiled(path: str, hash_value: str) -> str:
    """Mark a raw source as compiled and update its content hash.

    Returns JSON: {path, hash}
    """
    from loom_mcp.tools.compile import mark_source_compiled as _mark
    result = _mark(LOOM_ROOT, path, hash_value)
    return json.dumps(result, indent=2)


@mcp.tool()
def update_glossary(term: str, definition: str) -> str:
    """Append a term to the glossary.

    Returns JSON: {term, added}
    """
    from loom_mcp.tools.compile import update_glossary as _update
    result = _update(LOOM_ROOT, term, definition)
    return json.dumps(result, indent=2)


@mcp.tool()
def append_log(entry_type: str, title: str, details: str = "") -> str:
    """Append an entry to the chronological operation log (wiki/meta/log.md).

    Use after every ingest, compile, query, lint, or file-answer operation.
    Format: ## [YYYY-MM-DD] type | title

    Returns JSON: {timestamp, entry_type, title}
    """
    from loom_mcp.tools.compile import append_log as _log
    result = _log(LOOM_ROOT, entry_type, title, details)
    return json.dumps(result, indent=2)


@mcp.tool()
def update_master_index() -> str:
    """Regenerate wiki/meta/index.md — master catalog of ALL wiki pages.

    Lists every page with a link, one-line summary, type, and tags.
    The LLM reads this first when answering queries to find relevant pages.

    Returns JSON: {total_pages, categories}
    """
    from loom_mcp.tools.compile import update_master_index as _index
    result = _index(LOOM_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def detect_changes(since: str = "HEAD~1") -> str:
    """Detect changed files since a git ref using git diff.

    Returns JSON: [{path, status}] where status is added/modified/deleted.
    """
    from loom_mcp.tools.compile import detect_changes as _detect
    result = _detect(LOOM_ROOT, since)
    return json.dumps(result, indent=2)


@mcp.tool()
def get_stale_readmes() -> str:
    """Find folders whose contents changed but README hasn't been updated.

    Returns JSON: [{folder, readme_path, reason, changed_files}]
    """
    from loom_mcp.tools.compile import get_stale_readmes as _stale
    result = _stale(LOOM_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def save_chat_transcript(session_id: str, messages_json: str) -> str:
    """Save a chat transcript to raw/chats/.

    Args:
        session_id: Chat session ID.
        messages_json: JSON string of [{role, content}] messages.

    Returns JSON: {path, message_count}
    """
    from loom_mcp.tools.compile import save_chat_transcript as _save
    messages = json.loads(messages_json)
    result = _save(LOOM_ROOT, session_id, messages)
    return json.dumps(result, indent=2)


# --- Lint Tools ---

@mcp.tool()
def validate_links() -> str:
    """Check all [[wiki-links]] against the page registry. Returns broken links.

    Returns JSON: [{page, link, status}]
    """
    from loom_mcp.tools.lint import validate_links as _validate
    result = _validate(LOOM_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def find_stale_pages() -> str:
    """Find wiki pages whose source content has changed since compilation.

    Returns JSON: [{page, source, expected_hash, actual_hash}]
    """
    from loom_mcp.tools.lint import find_stale_pages as _find_stale
    result = _find_stale(LOOM_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def find_orphan_pages() -> str:
    """Find wiki pages with zero inbound backlinks.

    Returns JSON: [path]
    """
    from loom_mcp.tools.lint import find_orphan_pages as _find_orphans
    result = _find_orphans(LOOM_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def find_missing_concepts() -> str:
    """Find terms in related fields with no corresponding concept article.

    Returns JSON: [term]
    """
    from loom_mcp.tools.lint import find_missing_concepts as _find_missing
    result = _find_missing(LOOM_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def check_terminology(page_path: str) -> str:
    """Check a wiki page for terms not in the glossary.

    Returns JSON: [unknown_term]
    """
    from loom_mcp.tools.lint import check_terminology as _check
    result = _check(LOOM_ROOT, page_path)
    return json.dumps(result, indent=2)


@mcp.tool()
def generate_health_report() -> str:
    """Run all lint checks and write wiki/meta/health.md.

    Returns JSON: {broken_links, stale_pages, orphans, missing_concepts, total_issues}
    """
    from loom_mcp.tools.lint import generate_health_report as _gen_report
    result = _gen_report(LOOM_ROOT)
    return json.dumps(result, indent=2)


# --- Search Tools ---

@mcp.tool()
def search_by_tags(tags: list[str], scope: str = "all", match_all: bool = False) -> str:
    """Find pages and memories by frontmatter tags.

    Args:
        tags: Tags to search for (e.g. ["transformer-from-scratch"] or ["attention", "global"]).
        scope: "wiki", "memory", "projects", or "all".
        match_all: If True, page must have ALL tags. If False (default), any tag matches.

    Returns JSON: [{path, title, type, tags, summary}]
    """
    from loom_mcp.tools.search import search_by_tags as _search_tags
    result = _search_tags(LOOM_ROOT, tags, scope, match_all)
    return json.dumps(result, indent=2)


@mcp.tool()
def ripgrep_search(query: str, scope: str = "all", context_lines: int = 3, file_glob: str = "*") -> str:
    """Full-text search using ripgrep.

    Args:
        query: Search pattern (regex supported).
        scope: "raw", "wiki", "projects", or "all".
        context_lines: Lines of context around matches.
        file_glob: File pattern (e.g., "*.py" for code, "*.md" for markdown, "*" for everything).

    Returns JSON: [{path, line, context}]
    """
    from loom_mcp.tools.search import ripgrep_search as _rg
    result = _rg(LOOM_ROOT, query, scope, context_lines, file_glob)
    return json.dumps(result, indent=2)


@mcp.tool()
def read_index(topic: str) -> str:
    """Read a topic index file from wiki/meta/indexes/."""
    from loom_mcp.tools.search import read_index as _read_index
    return _read_index(LOOM_ROOT, topic)


@mcp.tool()
def write_index(topic: str, content: str) -> str:
    """Write or update a topic index file at wiki/meta/indexes/{topic}.md.

    Use this to maintain index files with brief summaries of all pages
    in a topic cluster. This is what makes Q&A work without RAG.

    Returns JSON: {path, topic, created}
    """
    from loom_mcp.tools.search import write_index as _write_index
    result = _write_index(LOOM_ROOT, topic, content)
    return json.dumps(result, indent=2)


# --- Git Tools ---

@mcp.tool()
def auto_commit(message: str) -> str:
    """Stage all wiki/ changes and commit.

    Returns JSON: {committed, hash, message} or {committed: false, reason}
    """
    from loom_mcp.tools.git import auto_commit as _commit
    result = _commit(LOOM_ROOT, message)
    return json.dumps(result, indent=2)


@mcp.tool()
def get_recent_changes(n: int = 10) -> str:
    """Get recent git log entries.

    Returns JSON: [{hash, message, date}]
    """
    from loom_mcp.tools.git import get_recent_changes as _recent
    result = _recent(LOOM_ROOT, n)
    return json.dumps(result, indent=2)


# --- VM tools ---

@mcp.tool()
def vm_bash(vm_id: str, command: str, timeout: int = 30) -> str:
    """Run a shell command on a remote VM.

    Returns JSON: {stdout, stderr, exit_code}.
    Use this for builds, tests, monitoring, and any shell operation on the VM.
    """
    import asyncio
    from loom_mcp.vm.config import get_vm
    from loom_mcp.vm.ssh import ssh_pool

    vm = get_vm(LOOM_ROOT, vm_id)
    if not vm:
        return json.dumps({"error": f"VM '{vm_id}' not found"})
    result = asyncio.get_event_loop().run_until_complete(
        ssh_pool.exec_command(vm, command, timeout=timeout)
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def vm_read(vm_id: str, file_path: str) -> str:
    """Read a file on a remote VM.

    Returns the file content as a string. Equivalent to the built-in Read tool
    but operates on the VM filesystem.
    """
    import asyncio
    from loom_mcp.vm.config import get_vm
    from loom_mcp.vm.ssh import ssh_pool

    vm = get_vm(LOOM_ROOT, vm_id)
    if not vm:
        return json.dumps({"error": f"VM '{vm_id}' not found"})
    try:
        content = asyncio.get_event_loop().run_until_complete(
            ssh_pool.read_file(vm, file_path)
        )
        return content
    except Exception as exc:
        return json.dumps({"error": str(exc)})


@mcp.tool()
def vm_write(vm_id: str, file_path: str, content: str) -> str:
    """Write a file on a remote VM.

    Creates or overwrites the file. Equivalent to the built-in Write tool
    but operates on the VM filesystem.
    """
    import asyncio
    from loom_mcp.vm.config import get_vm
    from loom_mcp.vm.ssh import ssh_pool

    vm = get_vm(LOOM_ROOT, vm_id)
    if not vm:
        return json.dumps({"error": f"VM '{vm_id}' not found"})
    try:
        asyncio.get_event_loop().run_until_complete(
            ssh_pool.write_file(vm, file_path, content)
        )
        return json.dumps({"ok": True, "path": file_path})
    except Exception as exc:
        return json.dumps({"error": str(exc)})


@mcp.tool()
def vm_edit(vm_id: str, file_path: str, old_string: str, new_string: str) -> str:
    """Edit a file on a remote VM by replacing old_string with new_string.

    Equivalent to the built-in Edit tool but operates on the VM filesystem.
    Reads the file, performs the replacement, and writes it back.
    """
    import asyncio
    from loom_mcp.vm.config import get_vm
    from loom_mcp.vm.ssh import ssh_pool

    vm = get_vm(LOOM_ROOT, vm_id)
    if not vm:
        return json.dumps({"error": f"VM '{vm_id}' not found"})
    try:
        loop = asyncio.get_event_loop()
        content = loop.run_until_complete(ssh_pool.read_file(vm, file_path))
        if old_string not in content:
            return json.dumps({"error": f"old_string not found in {file_path}"})
        count = content.count(old_string)
        if count > 1:
            return json.dumps({"error": f"old_string found {count} times — must be unique"})
        new_content = content.replace(old_string, new_string, 1)
        loop.run_until_complete(ssh_pool.write_file(vm, file_path, new_content))
        return json.dumps({"ok": True, "path": file_path})
    except Exception as exc:
        return json.dumps({"error": str(exc)})


@mcp.tool()
def vm_glob(vm_id: str, pattern: str, path: str = ".") -> str:
    """Find files by glob pattern on a remote VM.

    Returns JSON list of matching file paths. Equivalent to the built-in Glob tool
    but operates on the VM filesystem.
    """
    import asyncio
    from loom_mcp.vm.config import get_vm
    from loom_mcp.vm.ssh import ssh_pool

    vm = get_vm(LOOM_ROOT, vm_id)
    if not vm:
        return json.dumps({"error": f"VM '{vm_id}' not found"})
    base = path if path != "." else vm.get("sync_dir", "~")
    cmd = f"find {_shell_escape(base)} -path {_shell_escape('*' + pattern)} -not -path '*/.git/*' 2>/dev/null | head -200"
    result = asyncio.get_event_loop().run_until_complete(
        ssh_pool.exec_command(vm, cmd, timeout=15)
    )
    files = [l.strip() for l in result["stdout"].splitlines() if l.strip()]
    return json.dumps(files, indent=2)


@mcp.tool()
def vm_grep(vm_id: str, pattern: str, path: str = ".", file_glob: str = "") -> str:
    """Search file contents on a remote VM using grep.

    Returns JSON list of matches [{path, line, content}]. Equivalent to the
    built-in Grep tool but operates on the VM filesystem.
    """
    import asyncio
    from loom_mcp.vm.config import get_vm
    from loom_mcp.vm.ssh import ssh_pool

    vm = get_vm(LOOM_ROOT, vm_id)
    if not vm:
        return json.dumps({"error": f"VM '{vm_id}' not found"})
    base = path if path != "." else vm.get("sync_dir", "~")
    glob_arg = f"--include={_shell_escape(file_glob)}" if file_glob else ""
    escaped_pattern = _shell_escape(pattern)
    escaped_base = _shell_escape(base)
    # Try ripgrep first, fall back to grep
    cmd = (f"(command -v rg >/dev/null && rg -n --no-heading {glob_arg} -- {escaped_pattern} {escaped_base} 2>/dev/null "
           f"|| grep -rn {glob_arg} -- {escaped_pattern} {escaped_base} 2>/dev/null) | head -100")
    result = asyncio.get_event_loop().run_until_complete(
        ssh_pool.exec_command(vm, cmd, timeout=15)
    )
    matches = []
    for line in result["stdout"].splitlines():
        parts = line.split(":", 2)
        if len(parts) >= 3:
            matches.append({
                "path": parts[0],
                "line": int(parts[1]) if parts[1].isdigit() else 0,
                "content": parts[2].strip(),
            })
    return json.dumps(matches, indent=2)


@mcp.tool()
def vm_push(vm_id: str, local_path: str = ".", remote_path: str = "") -> str:
    """rsync push a local directory to a remote VM.

    Syncs files from local to VM, respecting configured excludes.
    Use local_path="." to push the current loom root.
    """
    import asyncio
    from loom_mcp.vm.config import get_vm
    from loom_mcp.vm import sync

    vm = get_vm(LOOM_ROOT, vm_id)
    if not vm:
        return json.dumps({"error": f"VM '{vm_id}' not found"})
    lp = str(LOOM_ROOT) if local_path == "." else local_path
    result = asyncio.get_event_loop().run_until_complete(
        sync.rsync_push(vm, lp, remote_path)
    )
    return json.dumps({
        "ok": result.ok, "files": result.files_transferred,
        "elapsed_ms": result.elapsed_ms, "error": result.error,
    }, indent=2)


@mcp.tool()
def vm_pull(vm_id: str, remote_path: str = ".", local_path: str = "") -> str:
    """rsync pull from a remote VM to local.

    Artifacts land in outputs/vm/{vm_id}/ by default.
    """
    import asyncio
    from loom_mcp.vm.config import get_vm
    from loom_mcp.vm import sync

    vm = get_vm(LOOM_ROOT, vm_id)
    if not vm:
        return json.dumps({"error": f"VM '{vm_id}' not found"})
    rp = "" if remote_path == "." else remote_path
    lp = local_path or str(LOOM_ROOT / "outputs" / "vm" / vm_id)
    Path(lp).mkdir(parents=True, exist_ok=True)
    result = asyncio.get_event_loop().run_until_complete(
        sync.rsync_pull(vm, rp, lp)
    )
    return json.dumps({
        "ok": result.ok, "files": result.files_transferred,
        "elapsed_ms": result.elapsed_ms, "error": result.error,
    }, indent=2)


@mcp.tool()
def vm_status(vm_id: str = "") -> str:
    """Get VM connection status and resource metrics.

    Omit vm_id to get status of all configured VMs.
    Returns JSON with connection status and basic resource info.
    """
    import asyncio
    from loom_mcp.vm.config import load_vms, get_vm
    from loom_mcp.vm.ssh import ssh_pool
    from loom_mcp.vm.metrics import METRICS_COMMAND, parse_metrics

    if vm_id:
        vm = get_vm(LOOM_ROOT, vm_id)
        if not vm:
            return json.dumps({"error": f"VM '{vm_id}' not found"})
        vms = [vm]
    else:
        vms = load_vms(LOOM_ROOT)

    results = []
    for vm in vms:
        status = ssh_pool.get_status(vm["id"])
        entry = {"id": vm["id"], "label": vm["label"], "host": vm["host"], "status": status}
        if status == "connected":
            try:
                r = asyncio.get_event_loop().run_until_complete(
                    ssh_pool.exec_command(vm, METRICS_COMMAND, timeout=10)
                )
                if r["exit_code"] == 0:
                    entry["metrics"] = parse_metrics(r["stdout"])
            except Exception:
                pass
        results.append(entry)

    return json.dumps(results, indent=2)


# --- Helpers ---

def _serialize_frontmatter(fm: dict) -> dict:
    """Convert non-serializable frontmatter values to strings."""
    result = {}
    for k, v in fm.items():
        if hasattr(v, "isoformat"):
            result[k] = v.isoformat()
        else:
            result[k] = v
    return result


# --- Server entrypoint ---

def main():
    """Run the MCP server with stdio transport."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()


# Also support `python -m loom_mcp.server`

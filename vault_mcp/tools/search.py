"""Search tools — ripgrep wrapper, index reader, and index writer."""

import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from vault_mcp.lib.frontmatter import read_frontmatter, write_frontmatter


def ripgrep_search(
    vault_root: Path,
    query: str,
    scope: str = "all",
    context_lines: int = 3,
    file_glob: str = "*",
) -> list[dict]:
    """Search file contents using ripgrep.

    Args:
        query: Search pattern (supports regex).
        scope: "raw", "wiki", "projects", or "all".
        context_lines: Number of context lines around matches.
        file_glob: File pattern to search (e.g., "*.py", "*.md", "*" for all).

    Returns: [{path, line, context}]
    """
    scope_map = {
        "raw": vault_root / "raw",
        "wiki": vault_root / "wiki",
        "projects": vault_root / "projects",
        "all": vault_root,
    }
    if scope in scope_map:
        search_path = scope_map[scope]
    else:
        # Treat scope as a relative path within the vault
        candidate = (vault_root / scope).resolve()
        if str(candidate).startswith(str(vault_root.resolve())) and candidate.exists():
            search_path = candidate
        else:
            search_path = vault_root

    # Find ripgrep — check common locations including Claude Code's vendored copy
    import shutil
    rg_path = shutil.which("rg")
    if not rg_path:
        # Check Claude Code's vendored ripgrep
        import platform
        arch = "arm64" if platform.machine() == "arm64" else "x64"
        system = "darwin" if platform.system() == "Darwin" else "linux"
        vendored = Path.home() / ".npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep" / f"{arch}-{system}" / "rg"
        if vendored.exists():
            rg_path = str(vendored)
        else:
            raise RuntimeError("ripgrep (rg) is not installed. Install it with: brew install ripgrep")

    cmd = [
        rg_path,
        "--json",
        "-C", str(context_lines),
        "--glob", file_glob,
        query,
        str(search_path),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        raise RuntimeError("ripgrep (rg) is not installed. Install it with: brew install ripgrep")
    except subprocess.TimeoutExpired:
        return [{"path": "", "line": 0, "context": "Search timed out"}]

    import json
    matches = []
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if data.get("type") == "match":
            match_data = data["data"]
            file_path = match_data["path"]["text"]
            try:
                rel_path = str(Path(file_path).relative_to(vault_root))
            except ValueError:
                rel_path = file_path
            matches.append({
                "path": rel_path,
                "line": match_data["line_number"],
                "context": match_data["lines"]["text"].rstrip(),
            })

    return matches


def filename_search(vault_root: Path, query: str, scope: str = "all") -> list[dict]:
    """Search for files by name using glob-style matching.

    Returns: [{path, line: 0, context: filename}]
    """
    import re
    scope_map = {
        "raw": vault_root / "raw",
        "wiki": vault_root / "wiki",
        "projects": vault_root / "projects",
        "all": vault_root,
    }
    if scope in scope_map:
        search_path = scope_map[scope]
    else:
        candidate = (vault_root / scope).resolve()
        if str(candidate).startswith(str(vault_root.resolve())) and candidate.exists():
            search_path = candidate
        else:
            search_path = vault_root

    pattern = re.compile(re.escape(query), re.IGNORECASE)
    matches = []
    for p in search_path.rglob("*"):
        if pattern.search(p.name):
            try:
                rel = str(p.relative_to(vault_root))
            except ValueError:
                rel = str(p)
            matches.append({"path": rel, "line": 0, "context": p.name})
            if len(matches) >= 50:
                break
    return matches


def read_index(vault_root: Path, topic: str) -> str:
    """Read a topic index file from wiki/indexes/.

    Args:
        topic: The topic name (used to find the index file).

    Returns: The index file content, or an error message if not found.
    """
    indexes_dir = vault_root / "wiki" / "indexes"
    if not indexes_dir.exists():
        return f"No indexes directory found."

    # Try exact match first, then slug match
    for md_file in indexes_dir.glob("*.md"):
        if md_file.stem.lower() == topic.lower():
            _, content = read_frontmatter(md_file)
            return content
        if md_file.stem.lower().replace("-", " ") == topic.lower():
            _, content = read_frontmatter(md_file)
            return content

    # List available indexes
    available = [f.stem for f in indexes_dir.glob("*.md")]
    if available:
        return f"Index '{topic}' not found. Available indexes: {', '.join(available)}"
    return f"Index '{topic}' not found. No indexes exist yet."


def write_index(vault_root: Path, topic: str, content: str) -> dict:
    """Write or update a topic index file at wiki/indexes/{topic}.md.

    The LLM uses this to maintain index files with brief summaries of all
    pages in a topic cluster — the key to making Q&A work without RAG.

    Args:
        topic: Topic name (used for filename and title).
        content: Markdown content for the index (the LLM writes this).

    Returns: {path, topic, created}
    """
    indexes_dir = vault_root / "wiki" / "indexes"
    indexes_dir.mkdir(parents=True, exist_ok=True)

    slug = re.sub(r"[^\w\s-]", "", topic.lower())
    slug = re.sub(r"[\s]+", "-", slug).strip("-")
    path = indexes_dir / f"{slug}.md"
    is_new = not path.exists()

    now = datetime.now(timezone.utc)
    metadata = {
        "title": f"{topic} — Index",
        "type": "index",
        "status": "compiled",
        "created": now.strftime("%Y-%m-%d") if is_new else None,
        "last_compiled": now.isoformat(),
    }

    # Preserve created date if updating
    if not is_new:
        try:
            old_meta, _ = read_frontmatter(path)
            metadata["created"] = old_meta.get("created", now.strftime("%Y-%m-%d"))
        except Exception:
            metadata["created"] = now.strftime("%Y-%m-%d")
    else:
        metadata["created"] = now.strftime("%Y-%m-%d")

    write_frontmatter(path, metadata, content)

    rel_path = str(path.relative_to(vault_root))
    return {"path": rel_path, "topic": topic, "created": is_new}

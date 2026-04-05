"""MCP server entrypoint — stdio transport, registers all vault tools."""

import json
import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP

# Resolve vault root: env var > config file > default
def _resolve_vault_root() -> Path:
    if "VAULT_ROOT" in os.environ:
        return Path(os.environ["VAULT_ROOT"])
    config = Path.home() / ".vault-app-config.json"
    if config.exists():
        try:
            import json as _json
            data = _json.loads(config.read_text())
            if data.get("vault_root"):
                return Path(data["vault_root"])
        except Exception:
            pass
    return Path.home() / "Documents" / "vault"

VAULT_ROOT = _resolve_vault_root()

mcp = FastMCP("vault", instructions="Personal knowledge base tools. All tools are deterministic — no LLM calls.")


def _bootstrap_vault(vault_root: Path) -> None:
    """Create the vault directory structure if it doesn't exist."""
    for d in ["raw/inbox", "raw/articles", "raw/papers", "raw/repos", "raw/media",
              "wiki/concepts", "wiki/summaries", "wiki/indexes", "wiki/answers", "wiki/meta",
              "outputs/slides", "outputs/reports", "outputs/visualizations"]:
        (vault_root / d).mkdir(parents=True, exist_ok=True)
    reg = vault_root / "wiki" / "meta" / "page-registry.json"
    if not reg.exists():
        reg.write_text('{"pages": []}', encoding="utf-8")


_bootstrap_vault(VAULT_ROOT)


# --- Ingestion Tools ---

@mcp.tool()
def ingest_url(url: str) -> str:
    """Fetch a URL via trafilatura and write to raw/inbox/ with frontmatter.

    Returns JSON: {path, title, content_hash}
    """
    from vault_mcp.tools.ingest import ingest_url as _ingest_url
    result = _ingest_url(VAULT_ROOT, url)
    return json.dumps(result, indent=2)


@mcp.tool()
def ingest_pdf(filepath: str) -> str:
    """Extract PDF to markdown via PyMuPDF4LLM and write to raw/inbox/.

    Returns JSON: {path, title, content_hash}
    """
    from vault_mcp.tools.ingest import ingest_pdf as _ingest_pdf
    result = _ingest_pdf(VAULT_ROOT, filepath)
    return json.dumps(result, indent=2)


@mcp.tool()
def ingest_text(text: str, title: str) -> str:
    """Write raw text to raw/inbox/ with frontmatter.

    Returns JSON: {path, content_hash}
    """
    from vault_mcp.tools.ingest import ingest_text as _ingest_text
    result = _ingest_text(VAULT_ROOT, text, title)
    return json.dumps(result, indent=2)


@mcp.tool()
def classify_inbox_item(source: str, destination: str) -> str:
    """Move a file from raw/inbox/ to the appropriate raw/ subdirectory.

    Args:
        source: Relative path (e.g., "raw/inbox/foo.md")
        destination: Relative path (e.g., "raw/articles/foo.md")

    Returns JSON: {old_path, new_path}
    """
    from vault_mcp.tools.ingest import classify_inbox_item as _classify
    result = _classify(VAULT_ROOT, source, destination)
    return json.dumps(result, indent=2)


# --- Compilation Tools ---

@mcp.tool()
def get_changed_sources() -> str:
    """Scan raw/ for files needing compilation (uncompiled or modified).

    Returns JSON: [{path, content_hash, old_hash, status}]
    """
    from vault_mcp.tools.compile import get_changed_sources as _get_changed
    result = _get_changed(VAULT_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def get_page_registry() -> str:
    """Read wiki/meta/page-registry.json.

    Returns JSON: {pages: [{title, path, aliases}]}
    """
    from vault_mcp.tools.compile import get_page_registry as _get_registry
    result = _get_registry(VAULT_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def get_glossary() -> str:
    """Read wiki/meta/glossary.md content."""
    from vault_mcp.tools.compile import get_glossary as _get_glossary
    return _get_glossary(VAULT_ROOT)


@mcp.tool()
def read_source(path: str) -> str:
    """Read a raw source file. Path is relative to vault root.

    Returns JSON: {frontmatter, content}
    """
    from vault_mcp.tools.compile import read_source as _read_source
    result = _read_source(VAULT_ROOT, path)
    # Serialize frontmatter (may contain datetime objects)
    result["frontmatter"] = _serialize_frontmatter(result["frontmatter"])
    return json.dumps(result, indent=2)


@mcp.tool()
def read_wiki_page(path: str) -> str:
    """Read a wiki page. Path is relative to vault root.

    Returns JSON: {frontmatter, content}
    """
    from vault_mcp.tools.compile import read_wiki_page as _read_wiki
    result = _read_wiki(VAULT_ROOT, path)
    result["frontmatter"] = _serialize_frontmatter(result["frontmatter"])
    return json.dumps(result, indent=2)


@mcp.tool()
def write_wiki_page(path: str, frontmatter_json: str, content: str) -> str:
    """Write a wiki page with frontmatter.

    Args:
        path: Relative path (e.g., "wiki/concepts/transformers.md")
        frontmatter_json: JSON string of frontmatter dict
        content: Markdown content body

    Returns JSON: {path, title, is_new}
    """
    from vault_mcp.tools.compile import write_wiki_page as _write_wiki
    page_frontmatter = json.loads(frontmatter_json)
    result = _write_wiki(VAULT_ROOT, path, page_frontmatter, content)
    return json.dumps(result, indent=2)


@mcp.tool()
def mark_source_compiled(path: str, hash_value: str) -> str:
    """Mark a raw source as compiled and update its content hash.

    Returns JSON: {path, hash}
    """
    from vault_mcp.tools.compile import mark_source_compiled as _mark
    result = _mark(VAULT_ROOT, path, hash_value)
    return json.dumps(result, indent=2)


@mcp.tool()
def update_glossary(term: str, definition: str) -> str:
    """Append a term to the glossary.

    Returns JSON: {term, added}
    """
    from vault_mcp.tools.compile import update_glossary as _update
    result = _update(VAULT_ROOT, term, definition)
    return json.dumps(result, indent=2)


@mcp.tool()
def append_log(entry_type: str, title: str, details: str = "") -> str:
    """Append an entry to the chronological operation log (wiki/meta/log.md).

    Use after every ingest, compile, query, lint, or file-answer operation.
    Format: ## [YYYY-MM-DD] type | title

    Returns JSON: {timestamp, entry_type, title}
    """
    from vault_mcp.tools.compile import append_log as _log
    result = _log(VAULT_ROOT, entry_type, title, details)
    return json.dumps(result, indent=2)


@mcp.tool()
def update_master_index() -> str:
    """Regenerate wiki/meta/index.md — master catalog of ALL wiki pages.

    Lists every page with a link, one-line summary, type, and tags.
    The LLM reads this first when answering queries to find relevant pages.

    Returns JSON: {total_pages, categories}
    """
    from vault_mcp.tools.compile import update_master_index as _index
    result = _index(VAULT_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def detect_changes(since: str = "HEAD~1") -> str:
    """Detect changed files since a git ref using git diff.

    Returns JSON: [{path, status}] where status is added/modified/deleted.
    """
    from vault_mcp.tools.compile import detect_changes as _detect
    result = _detect(VAULT_ROOT, since)
    return json.dumps(result, indent=2)


@mcp.tool()
def get_stale_readmes() -> str:
    """Find folders whose contents changed but README hasn't been updated.

    Returns JSON: [{folder, readme_path, reason, changed_files}]
    """
    from vault_mcp.tools.compile import get_stale_readmes as _stale
    result = _stale(VAULT_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def save_chat_transcript(session_id: str, messages_json: str) -> str:
    """Save a chat transcript to raw/chats/.

    Args:
        session_id: Chat session ID.
        messages_json: JSON string of [{role, content}] messages.

    Returns JSON: {path, message_count}
    """
    from vault_mcp.tools.compile import save_chat_transcript as _save
    messages = json.loads(messages_json)
    result = _save(VAULT_ROOT, session_id, messages)
    return json.dumps(result, indent=2)


# --- Lint Tools ---

@mcp.tool()
def validate_links() -> str:
    """Check all [[wiki-links]] against the page registry. Returns broken links.

    Returns JSON: [{page, link, status}]
    """
    from vault_mcp.tools.lint import validate_links as _validate
    result = _validate(VAULT_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def find_stale_pages() -> str:
    """Find wiki pages whose source content has changed since compilation.

    Returns JSON: [{page, source, expected_hash, actual_hash}]
    """
    from vault_mcp.tools.lint import find_stale_pages as _find_stale
    result = _find_stale(VAULT_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def find_orphan_pages() -> str:
    """Find wiki pages with zero inbound backlinks.

    Returns JSON: [path]
    """
    from vault_mcp.tools.lint import find_orphan_pages as _find_orphans
    result = _find_orphans(VAULT_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def find_missing_concepts() -> str:
    """Find terms in related fields with no corresponding concept article.

    Returns JSON: [term]
    """
    from vault_mcp.tools.lint import find_missing_concepts as _find_missing
    result = _find_missing(VAULT_ROOT)
    return json.dumps(result, indent=2)


@mcp.tool()
def check_terminology(page_path: str) -> str:
    """Check a wiki page for terms not in the glossary.

    Returns JSON: [unknown_term]
    """
    from vault_mcp.tools.lint import check_terminology as _check
    result = _check(VAULT_ROOT, page_path)
    return json.dumps(result, indent=2)


@mcp.tool()
def generate_health_report() -> str:
    """Run all lint checks and write wiki/meta/health.md.

    Returns JSON: {broken_links, stale_pages, orphans, missing_concepts, total_issues}
    """
    from vault_mcp.tools.lint import generate_health_report as _gen_report
    result = _gen_report(VAULT_ROOT)
    return json.dumps(result, indent=2)


# --- Search Tools ---

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
    from vault_mcp.tools.search import ripgrep_search as _rg
    result = _rg(VAULT_ROOT, query, scope, context_lines, file_glob)
    return json.dumps(result, indent=2)


@mcp.tool()
def read_index(topic: str) -> str:
    """Read a topic index file from wiki/indexes/."""
    from vault_mcp.tools.search import read_index as _read_index
    return _read_index(VAULT_ROOT, topic)


@mcp.tool()
def write_index(topic: str, content: str) -> str:
    """Write or update a topic index file at wiki/indexes/{topic}.md.

    Use this to maintain index files with brief summaries of all pages
    in a topic cluster. This is what makes Q&A work without RAG.

    Returns JSON: {path, topic, created}
    """
    from vault_mcp.tools.search import write_index as _write_index
    result = _write_index(VAULT_ROOT, topic, content)
    return json.dumps(result, indent=2)


# --- Git Tools ---

@mcp.tool()
def auto_commit(message: str) -> str:
    """Stage all wiki/ changes and commit.

    Returns JSON: {committed, hash, message} or {committed: false, reason}
    """
    from vault_mcp.tools.git import auto_commit as _commit
    result = _commit(VAULT_ROOT, message)
    return json.dumps(result, indent=2)


@mcp.tool()
def get_recent_changes(n: int = 10) -> str:
    """Get recent git log entries.

    Returns JSON: [{hash, message, date}]
    """
    from vault_mcp.tools.git import get_recent_changes as _recent
    result = _recent(VAULT_ROOT, n)
    return json.dumps(result, indent=2)


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


# Also support `python -m vault_mcp.server`

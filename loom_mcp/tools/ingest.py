"""Ingestion tools — URL, PDF, and text capture into raw/inbox/."""

import hashlib
import re
import shutil
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import trafilatura

from loom_mcp.lib.frontmatter import write_frontmatter
from loom_mcp.lib.hashing import content_hash


def _slugify(text: str) -> str:
    """Convert a title to a filesystem-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    return slug[:80].strip("-")


def _unique_path(directory: Path, slug: str, ext: str = ".md") -> Path:
    """Generate a unique file path, appending a counter if needed."""
    path = directory / f"{slug}{ext}"
    counter = 1
    while path.exists():
        path = directory / f"{slug}-{counter}{ext}"
        counter += 1
    return path


def _download_images(content: str, source_url: str, media_dir: Path) -> str:
    """Download images referenced in markdown and rewrite links to local paths.

    Returns the content with image URLs replaced by local paths.
    """
    media_dir.mkdir(parents=True, exist_ok=True)
    img_pattern = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")

    def replace_image(match):
        alt = match.group(1)
        img_url = match.group(2)

        # Resolve relative URLs
        if not img_url.startswith(("http://", "https://")):
            img_url = urljoin(source_url, img_url)

        try:
            # Generate deterministic filename from URL
            url_hash = hashlib.sha256(img_url.encode()).hexdigest()[:12]
            ext = Path(urlparse(img_url).path).suffix or ".png"
            ext = ext[:5]  # Limit extension length
            local_name = f"{url_hash}{ext}"
            local_path = media_dir / local_name

            if not local_path.exists():
                urllib.request.urlretrieve(img_url, str(local_path))

            rel_path = f"raw/media/{local_name}"
            return f"![{alt}]({rel_path})"
        except Exception:
            return match.group(0)  # Keep original on failure

    return img_pattern.sub(replace_image, content)


def ingest_url(loom_root: Path, url: str, download_images: bool = True) -> dict:
    """Fetch a URL via trafilatura and write to raw/inbox/ with frontmatter.

    Downloads embedded images to raw/media/ and rewrites links to local paths.

    Returns: {path, title, content_hash, images_downloaded}
    """
    downloaded = trafilatura.fetch_url(url)
    if downloaded is None:
        raise ValueError(f"Failed to fetch URL: {url}")

    result = trafilatura.extract(
        downloaded,
        output_format="markdown",
        include_links=True,
        include_images=True,
        with_metadata=True,
    )
    if result is None:
        raise ValueError(f"Failed to extract content from: {url}")

    content = result
    images_downloaded = 0

    # Download images locally
    if download_images:
        media_dir = loom_root / "raw" / "media"
        original = content
        content = _download_images(content, url, media_dir)
        # Count how many images were rewritten
        images_downloaded = content.count("raw/media/") - original.count("raw/media/")

    # Try to extract title from first heading or use URL
    title = url
    for line in content.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            title = line[2:].strip()
            break

    slug = _slugify(title)
    inbox = loom_root / "raw" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    path = _unique_path(inbox, slug)

    now = datetime.now(timezone.utc).isoformat()
    chash = content_hash(content)

    metadata = {
        "title": title,
        "source_url": url,
        "captured": now,
        "content_type": "article",
        "content_hash": chash,
        "tags": [],
        "compiled": False,
    }

    write_frontmatter(path, metadata, content)

    return {
        "path": str(path.relative_to(loom_root)),
        "title": title,
        "content_hash": chash,
        "images_downloaded": images_downloaded,
    }


def ingest_pdf(loom_root: Path, filepath: str) -> dict:
    """Extract PDF to markdown via PyMuPDF4LLM and write to raw/inbox/.

    Requires the 'pdf' extra: pip install loom-mcp[pdf]

    Returns: {path, title, content_hash}
    """
    try:
        import pymupdf4llm
    except ImportError:
        raise ImportError("pymupdf4llm is required for PDF ingestion. Install with: pip install loom-mcp[pdf]")

    source = Path(filepath)
    if not source.exists():
        raise FileNotFoundError(f"PDF not found: {filepath}")

    content = pymupdf4llm.to_markdown(str(source))
    title = source.stem.replace("-", " ").replace("_", " ").title()

    # Try to extract title from first heading
    for line in content.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            title = line[2:].strip()
            break

    slug = _slugify(title)
    inbox = loom_root / "raw" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    path = _unique_path(inbox, slug)

    now = datetime.now(timezone.utc).isoformat()
    chash = content_hash(content)

    metadata = {
        "title": title,
        "source_url": str(source.resolve()),
        "captured": now,
        "content_type": "paper",
        "content_hash": chash,
        "tags": [],
        "compiled": False,
    }

    write_frontmatter(path, metadata, content)

    return {
        "path": str(path.relative_to(loom_root)),
        "title": title,
        "content_hash": chash,
    }


def ingest_text(loom_root: Path, text: str, title: str) -> dict:
    """Write raw text to raw/inbox/ with frontmatter.

    Returns: {path, content_hash}
    """
    slug = _slugify(title)
    inbox = loom_root / "raw" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    path = _unique_path(inbox, slug)

    now = datetime.now(timezone.utc).isoformat()
    chash = content_hash(text)

    metadata = {
        "title": title,
        "captured": now,
        "content_type": "note",
        "content_hash": chash,
        "tags": [],
        "compiled": False,
    }

    write_frontmatter(path, metadata, text)

    return {
        "path": str(path.relative_to(loom_root)),
        "content_hash": chash,
    }


def classify_inbox_item(loom_root: Path, source: str, destination: str) -> dict:
    """Move a file from raw/inbox/ to the appropriate raw/ subdirectory.

    Args:
        source: Relative path from loom root (e.g., "raw/inbox/foo.md")
        destination: Relative path from loom root (e.g., "raw/articles/foo.md")

    Returns: {old_path, new_path}
    """
    root = loom_root.resolve()
    src = (loom_root / source).resolve()
    dst = (loom_root / destination).resolve()

    # Prevent path traversal
    if not str(src).startswith(str(root) + "/"):
        raise ValueError(f"Source path traversal blocked: {source}")
    if not str(dst).startswith(str(root) + "/"):
        raise ValueError(f"Destination path traversal blocked: {destination}")

    if not src.exists():
        raise FileNotFoundError(f"Source file not found: {source}")

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))

    return {"old_path": source, "new_path": destination}

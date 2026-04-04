"""Frontmatter read/write/validate utilities using python-frontmatter."""

from pathlib import Path
from typing import Any

import frontmatter


def read_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    """Read a markdown file and return (metadata dict, content body).

    The content body excludes the YAML frontmatter block.
    """
    post = frontmatter.load(str(path))
    return dict(post.metadata), post.content


def write_frontmatter(path: Path, metadata: dict[str, Any], content: str) -> None:
    """Write a markdown file with YAML frontmatter.

    Creates parent directories if they don't exist.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    post = frontmatter.Post(content, **metadata)
    path.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")


def validate_wiki_frontmatter(metadata: dict[str, Any]) -> list[str]:
    """Validate that wiki page frontmatter has all required fields.

    Returns a list of missing field names (empty if valid).
    """
    required = [
        "title", "type", "status", "created", "last_compiled",
        "source_hash", "compiler_model", "compiler_prompt_version",
        "sources", "tags", "related", "confidence",
    ]
    return [f for f in required if f not in metadata]


def validate_raw_frontmatter(metadata: dict[str, Any]) -> list[str]:
    """Validate that raw source frontmatter has all required fields.

    Returns a list of missing field names (empty if valid).
    """
    required = ["title", "captured", "content_type", "content_hash", "compiled"]
    return [f for f in required if f not in metadata]

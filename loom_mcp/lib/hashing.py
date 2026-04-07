"""SHA-256 content hashing utilities."""

import hashlib


def content_hash(text: str) -> str:
    """Compute SHA-256 hash of content text.

    The hash is computed on the content body only (frontmatter excluded).
    Normalizes line endings to LF and strips trailing whitespace for determinism.
    """
    normalized = text.replace("\r\n", "\n").rstrip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

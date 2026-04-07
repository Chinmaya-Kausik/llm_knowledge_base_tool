"""Git tools — auto-commit and recent changes."""

import subprocess
from pathlib import Path


def auto_commit(loom_root: Path, message: str) -> dict:
    """Stage all changes in wiki/ and commit.

    Returns: {committed, hash, message} or {committed: False, reason: str}
    """
    wiki_dir = loom_root / "wiki"

    # Stage wiki changes
    subprocess.run(
        ["git", "add", str(wiki_dir)],
        cwd=str(loom_root),
        capture_output=True,
        text=True,
    )

    # Check if there are staged changes
    status = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=str(loom_root),
        capture_output=True,
    )
    if status.returncode == 0:
        return {"committed": False, "reason": "No changes to commit"}

    # Commit
    result = subprocess.run(
        ["git", "commit", "-m", message],
        cwd=str(loom_root),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {"committed": False, "reason": result.stderr.strip()}

    # Get commit hash
    hash_result = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=str(loom_root),
        capture_output=True,
        text=True,
    )
    commit_hash = hash_result.stdout.strip()

    return {"committed": True, "hash": commit_hash, "message": message}


def get_recent_changes(loom_root: Path, n: int = 10) -> list[dict]:
    """Get recent git log entries.

    Returns: [{hash, message, date}]
    """
    result = subprocess.run(
        ["git", "log", f"-{n}", "--format=%H|%s|%aI"],
        cwd=str(loom_root),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []

    entries = []
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        parts = line.split("|", 2)
        if len(parts) == 3:
            entries.append({
                "hash": parts[0][:8],
                "message": parts[1],
                "date": parts[2],
            })

    return entries

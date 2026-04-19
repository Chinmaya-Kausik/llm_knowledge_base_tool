"""Ntfy notification integration — fire-and-forget push notifications."""

import json
import logging
from pathlib import Path
from urllib.request import Request, urlopen

log = logging.getLogger("loom.notify")


def _load_ntfy_config() -> dict | None:
    """Load ntfy config from ~/.loom-app-config.json."""
    config = Path.home() / ".loom-app-config.json"
    if not config.exists():
        return None
    try:
        data = json.loads(config.read_text())
        ntfy = data.get("ntfy")
        if not ntfy or not ntfy.get("topic"):
            return None
        return ntfy
    except Exception:
        return None


def send(title: str, message: str, tags: str = "loom", priority: int = 3) -> bool:
    """Send a notification via ntfy.sh. Fire-and-forget, never raises.

    Args:
        title: Notification title
        message: Notification body
        tags: Comma-separated tags (shown as emoji in ntfy app)
        priority: 1-5 (1=min, 3=default, 5=urgent)

    Returns True if sent successfully, False otherwise.
    """
    cfg = _load_ntfy_config()
    if not cfg:
        return False

    server = cfg.get("server", "https://ntfy.sh")
    topic = cfg["topic"]

    try:
        req = Request(
            f"{server}/{topic}",
            data=message.encode("utf-8"),
            headers={
                "Title": title,
                "Tags": tags,
                "Priority": str(priority),
            },
        )
        urlopen(req, timeout=5)
        log.info("[ntfy] Sent: %s — %s", title, message[:100])
        return True
    except Exception as e:
        log.warning("[ntfy] Send failed: %s", e)
        return False


def notify_agent_done(agent_name: str, summary: str = "") -> bool:
    """Notify when an agent finishes."""
    msg = summary[:200] if summary else "Agent finished."
    return send(f"Agent done ({agent_name})", msg, tags="robot")


def notify_job_done(job_name: str, vm_label: str = "", exit_code: int | None = None) -> bool:
    """Notify when a VM job finishes."""
    status = "completed" if exit_code == 0 or exit_code is None else f"failed (exit {exit_code})"
    location = f" on {vm_label}" if vm_label else ""
    return send(f"Job {status}", f"{job_name}{location}", tags="gear")


def notify_sync_done(direction: str, file_count: int, vm_label: str = "") -> bool:
    """Notify when sync completes."""
    location = f" ({vm_label})" if vm_label else ""
    return send(f"Sync {direction}", f"{file_count} files{location}", tags="arrows_counterclockwise")

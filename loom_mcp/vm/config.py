"""VM configuration — CRUD for VM connection details stored in {LOOM_ROOT}/.loom/vms.json."""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _vms_path(loom_root: Path) -> Path:
    return loom_root / ".loom" / "vms.json"


def load_vms(loom_root: Path) -> list[dict[str, Any]]:
    """Load all VM configs from disk."""
    path = _vms_path(loom_root)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("vms", [])
    except (json.JSONDecodeError, KeyError):
        return []


def save_vms(loom_root: Path, vms: list[dict[str, Any]]) -> None:
    """Save all VM configs to disk."""
    path = _vms_path(loom_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"vms": vms}, indent=2), encoding="utf-8")


def get_vm(loom_root: Path, vm_id: str) -> dict[str, Any] | None:
    """Get a single VM config by ID."""
    for vm in load_vms(loom_root):
        if vm["id"] == vm_id:
            return vm
    return None


def add_vm(loom_root: Path, label: str, host: str, user: str,
           port: int = 22, key_path: str = "", sync_dir: str = "~",
           sync_excludes: list[str] | None = None, color: str = "#4fc3f7") -> dict[str, Any]:
    """Add a new VM config. Returns the created VM dict."""
    vms = load_vms(loom_root)
    vm = {
        "id": str(uuid.uuid4())[:8],
        "label": label,
        "host": host,
        "port": port,
        "user": user,
        "key_path": key_path,
        "sync_dir": sync_dir,
        "sync_excludes": sync_excludes or [".git/", "__pycache__/", "node_modules/", ".venv/", "*.pyc"],
        "color": color,
        "created": datetime.now(timezone.utc).isoformat(),
        "last_connected": None,
    }
    vms.append(vm)
    save_vms(loom_root, vms)
    return vm


def update_vm(loom_root: Path, vm_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    """Update fields on a VM config. Returns updated VM or None if not found."""
    vms = load_vms(loom_root)
    for vm in vms:
        if vm["id"] == vm_id:
            # Only allow updating known fields
            allowed = {"label", "host", "port", "user", "key_path", "sync_dir",
                       "sync_excludes", "color", "last_connected"}
            for k, v in updates.items():
                if k in allowed:
                    vm[k] = v
            save_vms(loom_root, vms)
            return vm
    return None


def delete_vm(loom_root: Path, vm_id: str) -> bool:
    """Delete a VM config. Returns True if found and deleted."""
    vms = load_vms(loom_root)
    new_vms = [v for v in vms if v["id"] != vm_id]
    if len(new_vms) == len(vms):
        return False
    save_vms(loom_root, new_vms)
    return True

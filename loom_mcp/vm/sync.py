"""rsync-based file sync between local and VM."""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


@dataclass
class SyncResult:
    """Result of an rsync operation."""
    ok: bool
    files_transferred: int = 0
    bytes_transferred: int = 0
    elapsed_ms: int = 0
    file_list: list[str] = field(default_factory=list)
    error: str = ""


def _build_rsync_args(vm_config: dict[str, Any], local_path: str, remote_path: str,
                       direction: str, excludes: list[str] | None = None,
                       dry_run: bool = False) -> list[str]:
    """Build rsync command arguments."""
    host = vm_config["host"]
    port = vm_config.get("port", 22)
    user = vm_config.get("user", "")
    key_path = vm_config.get("key_path", "")
    sync_dir = vm_config.get("sync_dir", "~")

    remote = remote_path or sync_dir
    remote_spec = f"{user}@{host}:{remote}/" if user else f"{host}:{remote}/"

    ssh_cmd = f"ssh -p {port}"
    if key_path:
        expanded = str(Path(key_path).expanduser())
        ssh_cmd += f" -i {expanded}"
    ssh_cmd += " -o StrictHostKeyChecking=accept-new"  # Accept on first connect, verify after

    args = [
        "rsync", "-avz", "--progress",
        "-e", ssh_cmd,
    ]

    if dry_run:
        args.append("--dry-run")

    # Excludes
    all_excludes = excludes or vm_config.get("sync_excludes", [
        ".git/", "__pycache__/", "node_modules/", ".venv/", "*.pyc",
    ])
    for exc in all_excludes:
        args.extend(["--exclude", exc])

    if direction == "push":
        local = local_path.rstrip("/") + "/"
        args.extend([local, remote_spec])
    else:  # pull
        args.extend([remote_spec, local_path.rstrip("/") + "/"])

    return args


async def rsync_push(vm_config: dict[str, Any], local_path: str,
                     remote_path: str = "", excludes: list[str] | None = None,
                     dry_run: bool = False) -> SyncResult:
    """Push local directory to VM via rsync."""
    args = _build_rsync_args(vm_config, local_path, remote_path, "push", excludes, dry_run)
    return await _run_rsync(args)


async def rsync_pull(vm_config: dict[str, Any], remote_path: str = "",
                     local_path: str = "", excludes: list[str] | None = None,
                     dry_run: bool = False) -> SyncResult:
    """Pull from VM to local via rsync."""
    args = _build_rsync_args(vm_config, local_path, remote_path, "pull", excludes, dry_run)
    return await _run_rsync(args)


async def _run_rsync(args: list[str]) -> SyncResult:
    """Execute rsync and parse output."""
    start = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
        elapsed = int((time.monotonic() - start) * 1000)

        if proc.returncode != 0:
            return SyncResult(
                ok=False,
                elapsed_ms=elapsed,
                error=stderr.decode(errors="replace").strip(),
            )

        output = stdout.decode(errors="replace")
        file_list = _parse_file_list(output)

        return SyncResult(
            ok=True,
            files_transferred=len(file_list),
            elapsed_ms=elapsed,
            file_list=file_list,
        )
    except asyncio.TimeoutError:
        return SyncResult(ok=False, error="rsync timed out after 300s")
    except FileNotFoundError:
        return SyncResult(ok=False, error="rsync not found — install rsync")
    except Exception as exc:
        return SyncResult(ok=False, error=str(exc))


def _parse_file_list(rsync_output: str) -> list[str]:
    """Parse transferred file names from rsync verbose output."""
    files = []
    for line in rsync_output.splitlines():
        line = line.strip()
        # Skip rsync summary lines and empty lines
        if not line or line.startswith("sending") or line.startswith("receiving"):
            continue
        if line.startswith("sent ") or line.startswith("total "):
            continue
        if line.startswith("building file list"):
            continue
        if line.endswith("/"):
            continue  # Directory entries
        # File lines in verbose mode are just the filename
        if not line.startswith(" ") and "/" not in line[:2]:
            files.append(line)
    return files

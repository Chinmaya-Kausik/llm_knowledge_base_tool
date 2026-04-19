"""Lightweight sync daemon — keeps laptop ↔ VM in sync.

Runs as a background asyncio task in the web server's lifespan,
or standalone via `loom-sync` command.

Logic:
- Polls every 60s for local changes (git status)
- On change: debounce 10s, rsync push to VM
- On wake from sleep (time gap > 3× poll interval): pull from VM first
- Before each sync: git add + commit for merge safety
- Sends ntfy notification on sync complete
"""

import asyncio
import logging
import subprocess
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("loom.sync")


class SyncDaemon:
    """Bidirectional sync between local loom and a VM."""

    def __init__(self, loom_root: Path, vm_config: dict[str, Any],
                 poll_interval: int = 60, debounce: int = 10) -> None:
        self.loom_root = loom_root
        self.vm_config = vm_config
        self.poll_interval = poll_interval
        self.debounce = debounce
        self._last_tick = time.monotonic()
        self._pending_push = False

    async def run(self) -> None:
        """Main loop — runs until cancelled."""
        log.info("[sync] Daemon started for VM %s (%s)",
                 self.vm_config.get("label", ""), self.vm_config.get("host", ""))

        while True:
            try:
                now = time.monotonic()
                gap = now - self._last_tick

                # Detect wake from sleep (gap > 3× poll interval)
                if gap > self.poll_interval * 3:
                    log.info("[sync] Detected wake from sleep (gap=%.0fs), pulling first", gap)
                    await self._pull()

                # Check for local changes
                if self._has_local_changes():
                    self._pending_push = True

                if self._pending_push:
                    # Debounce — wait a bit for more changes
                    await asyncio.sleep(self.debounce)
                    await self._push()
                    self._pending_push = False

                self._last_tick = time.monotonic()
                await asyncio.sleep(self.poll_interval)

            except asyncio.CancelledError:
                log.info("[sync] Daemon stopped")
                return
            except Exception as e:
                log.error("[sync] Error: %s", e)
                await asyncio.sleep(self.poll_interval)

    async def _push(self) -> None:
        """Commit local changes, then rsync push to VM."""
        self._git_commit_local()

        from loom_mcp.vm.sync import rsync_push
        result = await rsync_push(
            self.vm_config,
            str(self.loom_root),
            self.vm_config.get("sync_dir", "~"),
        )

        if result.ok:
            log.info("[sync] Pushed %d files to VM", result.files_transferred)
            if result.files_transferred > 0:
                try:
                    from loom_mcp.notify import notify_sync_done
                    notify_sync_done("push", result.files_transferred,
                                     self.vm_config.get("label", ""))
                except Exception:
                    pass
        else:
            log.error("[sync] Push failed: %s", result.error)

    async def _pull(self) -> None:
        """Commit local changes first, then rsync pull from VM."""
        self._git_commit_local()

        from loom_mcp.vm.sync import rsync_pull
        local_path = str(self.loom_root)
        result = await rsync_pull(
            self.vm_config,
            self.vm_config.get("sync_dir", "~"),
            local_path,
        )

        if result.ok:
            if result.files_transferred > 0:
                log.info("[sync] Pulled %d files from VM", result.files_transferred)
                try:
                    from loom_mcp.notify import notify_sync_done
                    notify_sync_done("pull", result.files_transferred,
                                     self.vm_config.get("label", ""))
                except Exception:
                    pass
        else:
            log.error("[sync] Pull failed: %s", result.error)

    def _git_commit_local(self) -> None:
        """Auto-commit local changes for merge safety."""
        cwd = str(self.loom_root)
        try:
            # Init if needed
            if not (self.loom_root / ".git").exists():
                subprocess.run(["git", "init"], cwd=cwd, capture_output=True, timeout=10)
                subprocess.run(["git", "add", "-A"], cwd=cwd, capture_output=True, timeout=10)
                subprocess.run(["git", "commit", "-m", "Initial sync commit"],
                               cwd=cwd, capture_output=True, timeout=10)
                return

            # Check for changes
            r = subprocess.run(["git", "status", "--porcelain"],
                               cwd=cwd, capture_output=True, text=True, timeout=10)
            if r.stdout.strip():
                subprocess.run(["git", "add", "-A"], cwd=cwd, capture_output=True, timeout=10)
                subprocess.run(
                    ["git", "commit", "-m", f"Auto-sync {time.strftime('%Y-%m-%d %H:%M:%S')}"],
                    cwd=cwd, capture_output=True, timeout=10,
                )
        except FileNotFoundError:
            log.warning("[sync] git not found, skipping safety commit")
        except subprocess.TimeoutExpired:
            log.warning("[sync] git command timed out")
        except Exception as e:
            log.warning("[sync] git commit failed: %s", e)

    def _has_local_changes(self) -> bool:
        """Quick check for uncommitted local changes."""
        cwd = str(self.loom_root)
        try:
            r = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=cwd, capture_output=True, text=True, timeout=10,
            )
            return bool(r.stdout.strip())
        except Exception:
            return False


def load_sync_config(loom_root: Path) -> dict[str, Any] | None:
    """Load sync VM config. Returns VM config dict or None if not configured."""
    import json

    config_path = Path.home() / ".loom-app-config.json"
    if not config_path.exists():
        return None

    try:
        data = json.loads(config_path.read_text())
        sync_vm_id = data.get("sync_vm")
        if not sync_vm_id:
            return None

        from loom_mcp.vm.config import get_vm
        return get_vm(loom_root, sync_vm_id)
    except Exception:
        return None


async def run_sync_daemon(loom_root: Path) -> asyncio.Task | None:
    """Start the sync daemon if configured. Returns the task or None."""
    vm_config = load_sync_config(loom_root)
    if not vm_config:
        return None

    daemon = SyncDaemon(loom_root, vm_config)
    task = asyncio.create_task(daemon.run())
    return task


def main() -> None:
    """Standalone entry point: `loom-sync`."""
    import json
    import os

    loom_root_str = os.environ.get("LOOM_ROOT")
    if not loom_root_str:
        config = Path.home() / ".loom-app-config.json"
        if config.exists():
            data = json.loads(config.read_text())
            loom_root_str = data.get("loom_root")
    if not loom_root_str:
        loom_root_str = str(Path.home() / "Documents" / "loom")

    loom_root = Path(loom_root_str)
    vm_config = load_sync_config(loom_root)
    if not vm_config:
        print("No sync VM configured. Set 'sync_vm' in ~/.loom-app-config.json")
        return

    print(f"Sync daemon: {loom_root} ↔ {vm_config.get('label', vm_config['host'])}")
    daemon = SyncDaemon(loom_root, vm_config)
    asyncio.run(daemon.run())

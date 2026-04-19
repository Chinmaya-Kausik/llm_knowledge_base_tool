"""SSH connection pool — persistent asyncssh connections per VM, multiplexed channels."""

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import asyncssh

log = logging.getLogger(__name__)


class SSHPool:
    """Manages persistent SSH connections to VMs.

    One connection per VM, reused across terminal panels, MCP tools,
    metrics polling, and file operations.
    """

    def __init__(self) -> None:
        self._connections: dict[str, asyncssh.SSHClientConnection] = {}
        self._status: dict[str, str] = {}  # vm_id -> "connected"|"connecting"|"disconnected"|"error"
        self._locks: dict[str, asyncio.Lock] = {}
        self._tunnels: dict[str, dict[int, Any]] = {}  # vm_id -> {local_port: listener}

    def get_status(self, vm_id: str) -> str:
        """Get connection status for a VM."""
        return self._status.get(vm_id, "disconnected")

    async def connect(self, vm_config: dict[str, Any]) -> asyncssh.SSHClientConnection:
        """Get or create a connection to a VM. Reconnects if stale."""
        vm_id = vm_config["id"]

        if vm_id not in self._locks:
            self._locks[vm_id] = asyncio.Lock()

        async with self._locks[vm_id]:
            # Check existing connection
            conn = self._connections.get(vm_id)
            if conn is not None:
                try:
                    # Test if connection is alive
                    result = await asyncio.wait_for(conn.run("echo ok", check=True), timeout=5)
                    if result.stdout.strip() == "ok":
                        return conn
                except Exception:
                    log.info("[ssh] Connection to %s stale, reconnecting", vm_id)
                    try:
                        conn.close()
                    except Exception:
                        pass

            # Create new connection
            self._status[vm_id] = "connecting"
            try:
                kwargs: dict[str, Any] = {
                    "host": vm_config["host"],
                    "port": vm_config.get("port", 22),
                    "username": vm_config.get("user", ""),
                    "known_hosts": None,  # Accept any host key (user manages trust)
                }
                key_path = vm_config.get("key_path", "")
                if key_path:
                    expanded = str(Path(key_path).expanduser())
                    kwargs["client_keys"] = [expanded]

                conn = await asyncio.wait_for(
                    asyncssh.connect(**kwargs),
                    timeout=15,
                )
                self._connections[vm_id] = conn
                self._status[vm_id] = "connected"
                log.info("[ssh] Connected to %s (%s@%s:%d)",
                         vm_id, vm_config.get("user"), vm_config["host"], vm_config.get("port", 22))
                return conn
            except Exception as exc:
                self._status[vm_id] = "error"
                log.error("[ssh] Failed to connect to %s: %s", vm_id, exc)
                raise

    async def disconnect(self, vm_id: str) -> None:
        """Close connection to a VM."""
        conn = self._connections.pop(vm_id, None)
        if conn:
            conn.close()
        # Close any active tunnels
        tunnels = self._tunnels.pop(vm_id, {})
        for listener in tunnels.values():
            listener.close()
        self._status[vm_id] = "disconnected"

    async def disconnect_all(self) -> None:
        """Close all connections."""
        for vm_id in list(self._connections.keys()):
            await self.disconnect(vm_id)

    async def exec_command(self, vm_config: dict[str, Any], command: str,
                           timeout: int = 30) -> dict[str, Any]:
        """Execute a command on a VM. Returns {stdout, stderr, exit_code}."""
        conn = await self.connect(vm_config)
        try:
            result = await asyncio.wait_for(
                conn.run(command, check=False),
                timeout=timeout,
            )
            return {
                "stdout": result.stdout or "",
                "stderr": result.stderr or "",
                "exit_code": result.exit_status or 0,
            }
        except asyncio.TimeoutError:
            return {"stdout": "", "stderr": f"Command timed out after {timeout}s", "exit_code": -1}

    async def read_file(self, vm_config: dict[str, Any], path: str) -> str:
        """Read a file on the VM via SFTP."""
        conn = await self.connect(vm_config)
        async with conn.start_sftp_client() as sftp:
            async with sftp.open(path, "r") as f:
                return await f.read()

    async def write_file(self, vm_config: dict[str, Any], path: str, content: str) -> None:
        """Write a file on the VM via SFTP."""
        conn = await self.connect(vm_config)
        async with conn.start_sftp_client() as sftp:
            async with sftp.open(path, "w") as f:
                await f.write(content)

    async def list_dir(self, vm_config: dict[str, Any], path: str) -> list[dict[str, Any]]:
        """List directory contents on the VM via SFTP."""
        conn = await self.connect(vm_config)
        async with conn.start_sftp_client() as sftp:
            entries = []
            try:
                for attrs in await sftp.readdir(path):
                    name = attrs.filename
                    if name in (".", ".."):
                        continue
                    entries.append({
                        "name": name,
                        "type": "folder" if attrs.permissions and (attrs.permissions & 0o40000) else "file",
                        "size": attrs.size or 0,
                        "mtime": attrs.mtime or 0,
                    })
            except asyncssh.SFTPNoSuchFile:
                return []
            return sorted(entries, key=lambda e: (e["type"] != "folder", e["name"].lower()))

    async def open_shell(self, vm_config: dict[str, Any],
                         term_type: str = "xterm-256color",
                         cols: int = 120, rows: int = 40) -> asyncssh.SSHClientProcess:
        """Open an interactive shell session for terminal panels."""
        conn = await self.connect(vm_config)
        process = await conn.create_process(
            term_type=term_type,
            term_size=(cols, rows),
            encoding=None,  # Binary mode
        )
        return process

    async def resolve_path(self, vm_config: dict[str, Any], path: str) -> str:
        """Resolve ~ and env vars in a remote path to an absolute path."""
        if "~" not in path and "$" not in path:
            return path
        r = await self.exec_command(vm_config, f"echo {path}", timeout=5)
        return r["stdout"].strip() or path

    async def forward_local_port(self, vm_config: dict[str, Any],
                                 local_port: int, remote_port: int) -> bool:
        """Create an SSH tunnel: localhost:local_port -> VM:remote_port."""
        vm_id = vm_config["id"]
        conn = await self.connect(vm_config)
        try:
            listener = await conn.forward_local_port("", local_port, "localhost", remote_port)
            if vm_id not in self._tunnels:
                self._tunnels[vm_id] = {}
            self._tunnels[vm_id][local_port] = listener
            log.info("[ssh] Tunnel: localhost:%d -> %s:%d", local_port, vm_id, remote_port)
            return True
        except Exception as exc:
            log.error("[ssh] Failed to create tunnel: %s", exc)
            return False

    async def close_tunnel(self, vm_id: str, local_port: int) -> bool:
        """Close an SSH tunnel."""
        tunnels = self._tunnels.get(vm_id, {})
        listener = tunnels.pop(local_port, None)
        if listener:
            listener.close()
            return True
        return False

    def get_tunnels(self, vm_id: str) -> list[dict[str, int]]:
        """List active tunnels for a VM."""
        tunnels = self._tunnels.get(vm_id, {})
        result = []
        for local_port, listener in tunnels.items():
            # asyncssh forward_local_port stores the remote info on the listener
            result.append({"local_port": local_port})
        return result


# Singleton pool
ssh_pool = SSHPool()

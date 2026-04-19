"""VM integration — SSH connection pool, sync, metrics, jobs."""

from loom_mcp.vm.config import load_vms, save_vms, add_vm, update_vm, delete_vm, get_vm
from loom_mcp.vm.ssh import ssh_pool

__all__ = [
    "load_vms", "save_vms", "add_vm", "update_vm", "delete_vm", "get_vm",
    "ssh_pool",
]

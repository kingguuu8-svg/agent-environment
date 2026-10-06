"""PROTOTYPE: a native stdio MCP tool bundle, installed on the SSH target."""

import argparse
import asyncio
import os
import signal
import socket
import sys
import tempfile
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


def create_worker(workspace: Path) -> FastMCP:
    workspace = workspace.resolve()
    server = FastMCP("remote-machine-tools")

    def resolve_file(path: str) -> Path:
        resolved = (workspace / path).resolve()
        if not resolved.is_relative_to(workspace):
            raise ValueError(
                "File tools require a path inside the configured workspace"
            )
        return resolved

    def save(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".mcp-write-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(content)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    @server.tool()
    def machine_info() -> dict[str, Any]:
        """Identify the machine, user, and workspace where these tools execute."""
        return {
            "hostname": socket.gethostname(),
            "pid": os.getpid(),
            "user_id": os.getuid(),
            "workspace": str(workspace),
            "python": sys.version.split()[0],
        }

    @server.tool()
    def read_file(path: str) -> dict[str, Any]:
        """Read a UTF-8 file inside this machine's configured workspace."""
        resolved = resolve_file(path)
        if resolved.stat().st_size > 1_048_576:
            raise ValueError("The demo reads files up to 1 MiB")
        return {"path": str(resolved), "content": resolved.read_text(encoding="utf-8")}

    @server.tool()
    def write_file(path: str, content: str) -> dict[str, Any]:
        """Create or replace a UTF-8 file inside this machine's workspace."""
        resolved = resolve_file(path)
        save(resolved, content)
        return {"path": str(resolved), "bytes": len(content.encode("utf-8"))}

    @server.tool()
    def edit_file(path: str, old_text: str, new_text: str) -> dict[str, Any]:
        """Replace one exact occurrence; reject missing or ambiguous matches."""
        if not old_text:
            raise ValueError("old_text must be non-empty")
        resolved = resolve_file(path)
        content = resolved.read_text(encoding="utf-8")
        count = content.count(old_text)
        if count != 1:
            raise ValueError(f"Expected exactly one match, found {count}")
        save(resolved, content.replace(old_text, new_text, 1))
        return {"path": str(resolved), "replacements": 1}

    @server.tool()
    async def run_command(command: str, timeout_seconds: int = 30) -> dict[str, Any]:
        """Run bash in this workspace with the SSH user's OS permissions."""
        if not 1 <= timeout_seconds <= 120:
            raise ValueError("timeout_seconds must be between 1 and 120")
        process = await asyncio.create_subprocess_exec(
            "bash",
            "-lc",
            command,
            cwd=workspace,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        timed_out = False
        try:
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), timeout=timeout_seconds
                )
            except TimeoutError:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = await process.communicate()
        finally:
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
        return {
            "exit_code": process.returncode,
            "stdout": stdout[:1_048_576].decode("utf-8", errors="replace"),
            "stderr": stderr[:1_048_576].decode("utf-8", errors="replace"),
            "timed_out": timed_out,
        }

    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    workspace = parser.parse_args().workspace
    workspace.mkdir(parents=True, exist_ok=True)
    create_worker(workspace).run(transport="stdio")

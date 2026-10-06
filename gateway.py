"""PROTOTYPE: an always-available MCP entrypoint with SSH-managed backends."""

import argparse
import asyncio
import json
import logging
import os
import re
import shlex
import sys
import weakref
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path

import uvicorn
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.stdio import stdio_server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.applications import Starlette
from starlette.routing import Route

from worker import create_worker

ROOT = Path(__file__).resolve().parent
WORKER_REQUIREMENT = "mcp==1.26.0"
LOG = logging.getLogger("remote-mcp-demo")


class GatewayServer(Server):
    def get_capabilities(self, notification_options, experimental_capabilities):
        # The HTTP manager constructs initialization options itself.
        notification_options.tools_changed = True
        return super().get_capabilities(notification_options, experimental_capabilities)


def load_targets(config: Path) -> dict[str, dict]:
    targets = json.loads(config.read_text(encoding="utf-8"))["targets"]
    if not targets:
        raise ValueError("Configure at least one SSH target")
    for machine, target in targets.items():
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", machine) or "__" in machine:
            raise ValueError(f"Invalid machine name: {machine}")
        host = target["host"]
        if not host or host.startswith("-") or any(c.isspace() for c in host):
            raise ValueError(f"Invalid SSH host for {machine}")
        target.setdefault("workspace", ".local/share/remote-mcp-demo/workspace")
        target.setdefault("remote_base", ".local/share/remote-mcp-demo/bundle")
        target.setdefault("python", "python3")
        target.setdefault("port", 22)
        if not 1 <= target["port"] <= 65535:
            raise ValueError(f"Invalid SSH port for {machine}")
        for field in ("identity_file", "known_hosts_file"):
            if target.get(field):
                path = Path(target[field]).expanduser()
                target[field] = str((config.parent / path).resolve())
    return targets


def ssh_args(target: dict) -> list[str]:
    args = [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
        "-p",
        str(target["port"]),
    ]
    if target.get("identity_file"):
        args.extend(["-i", target["identity_file"], "-o", "IdentitiesOnly=yes"])
    if target.get("known_hosts_file"):
        path = target["known_hosts_file"].replace("\\", "\\\\").replace('"', '\\"')
        args.extend(["-o", f'UserKnownHostsFile="{path}"'])
    return [*args, target["host"]]


async def bootstrap(target: dict) -> dict:
    command = shlex.join([target["python"], "-c", (ROOT / "bootstrap.py").read_text()])
    process = await asyncio.create_subprocess_exec(
        "ssh",
        *ssh_args(target),
        command,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    request = {
        "remote_base": target["remote_base"],
        "workspace": target["workspace"],
        "worker_source": (ROOT / "worker.py").read_text(),
        "requirement": WORKER_REQUIREMENT,
        "index_url": target.get("index_url", "https://pypi.org/simple"),
    }
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(json.dumps(request).encode()), timeout=240
        )
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    if process.returncode:
        raise RuntimeError(
            f"SSH bootstrap failed: {stderr.decode(errors='replace')[-3000:]}"
        )
    return json.loads(stdout)


class Backend:
    """One task owns all stdio/session context managers for this connection."""

    def __init__(self, gateway: "Gateway", machine: str, target: dict):
        self.gateway = gateway
        self.machine = machine
        self.target = target
        self.state = "disconnected"
        self.error: str | None = None
        self.tools: list[types.Tool] = []
        self.info: dict = {}
        self.session: ClientSession | None = None
        self.stop = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.ready: asyncio.Future | None = None

    async def connect(self) -> None:
        self.state = "connecting"
        self.error = None
        try:
            self.info = await bootstrap(self.target)
            self.ready = asyncio.get_running_loop().create_future()
            self.task = asyncio.create_task(self.run())
            await self.ready
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception as error:
            self.state = "failed"
            self.error = str(error)
            raise

    async def update_tools(self) -> None:
        result = await self.session.list_tools()
        # The SDK client exposes pagination; consume it before publishing.
        tools = list(result.tools)
        while result.nextCursor:
            result = await self.session.list_tools(cursor=result.nextCursor)
            tools.extend(result.tools)
        if tools != self.tools:
            self.tools = tools
            await self.gateway.notify()

    async def run(self) -> None:
        command = shlex.join(
            [
                self.info["python"],
                self.info["worker"],
                "--workspace",
                self.info["workspace"],
            ]
        )
        params = StdioServerParameters(
            command="ssh",
            args=[*ssh_args(self.target), command],
            env={"SSH_AUTH_SOCK": os.environ["SSH_AUTH_SOCK"]}
            if "SSH_AUTH_SOCK" in os.environ
            else None,
        )
        try:
            async with stdio_client(params) as (read, write):
                async with ClientSession(
                    read, write, read_timeout_seconds=timedelta(seconds=150)
                ) as session:
                    self.session = session
                    await session.initialize()
                    self.state = "ready"
                    await self.update_tools()
                    self.ready.set_result(None)
                    while not self.stop.is_set():
                        try:
                            await asyncio.wait_for(self.stop.wait(), timeout=5)
                        except TimeoutError:
                            await self.update_tools()
        except Exception as error:
            self.state = "failed"
            self.error = str(error)
            if not self.ready.done():
                self.ready.set_exception(error)
            LOG.warning("%s disconnected: %s", self.machine, error)
        finally:
            self.session = None
            self.tools = []
            if self.state != "failed":
                self.state = "disconnected"
            await self.gateway.notify()

    async def close(self) -> None:
        self.stop.set()
        if self.task:
            await self.task
        self.state = "disconnected"
        self.error = None


class Gateway:
    def __init__(self, targets: dict[str, dict]):
        self.targets = targets
        self.backends: dict[str, Backend] = {}
        self.locks = {name: asyncio.Lock() for name in targets}
        self.clients = weakref.WeakSet()
        self.server = GatewayServer("remote-mcp-demo")
        # The bundle is selected before installation. Its contract is available
        # even for clients that snapshot the tool list at the start of a turn.
        self.bundle = create_worker(ROOT)

        @self.server.list_tools()
        async def list_tools() -> list[types.Tool]:
            self.clients.add(self.server.request_context.session)
            tools = self.management_tools()
            declared = await self.bundle.list_tools()
            for machine in self.targets:
                backend = self.backends.get(machine)
                native = (
                    backend.tools if backend and backend.state == "ready" else declared
                )
                tools.extend(
                    tool.model_copy(update={"name": f"{machine}__{tool.name}"})
                    for tool in native
                )
            return tools

        @self.server.call_tool()
        async def call_tool(name: str, arguments: dict):
            self.clients.add(self.server.request_context.session)
            if name == "list_machines":
                return {"machines": self.status()}
            if name in ("connect_machine", "disconnect_machine"):
                machine = arguments["machine"]
                if machine not in targets:
                    raise ValueError(f"Unknown machine: {machine}")
                async with self.locks[machine]:
                    backend = self.backends.get(machine)
                    if name == "disconnect_machine":
                        if backend:
                            await backend.close()
                        return {"machine": machine, "state": "disconnected"}
                    if backend and backend.state == "ready":
                        return {
                            "machine": machine,
                            "state": "ready",
                            "already_connected": True,
                        }
                    if backend:
                        await backend.close()
                    backend = Backend(self, machine, targets[machine])
                    self.backends[machine] = backend
                    await backend.connect()
                    return {
                        "machine": machine,
                        "state": backend.state,
                        "reused_bundle": backend.info["reused"],
                        "workspace": backend.info["workspace"],
                        "tools": [f"{machine}__{tool.name}" for tool in backend.tools],
                    }
            machine, separator, remote_name = name.partition("__")
            backend = self.backends.get(machine)
            if not separator or not backend or backend.state != "ready":
                raise ValueError(
                    f"Tool {name} is unavailable; connect its machine first"
                )
            if remote_name not in {tool.name for tool in backend.tools}:
                raise ValueError(f"Unknown remote tool: {name}")
            # Preserve every MCP content block, structured output, and isError.
            return await backend.session.call_tool(remote_name, arguments)

    def management_tools(self) -> list[types.Tool]:
        machine_schema = {
            "type": "object",
            "properties": {"machine": {"type": "string", "enum": list(self.targets)}},
            "required": ["machine"],
            "additionalProperties": False,
        }
        return [
            types.Tool(
                name="list_machines",
                description="List configured SSH machines and their tool connection state.",
                inputSchema={
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            ),
            types.Tool(
                name="connect_machine",
                description=(
                    "Prepare this machine's MCP bundle over SSH, start it, and publish "
                    "its native tools. First connection can take several minutes."
                ),
                inputSchema=machine_schema,
            ),
            types.Tool(
                name="disconnect_machine",
                description="Close the remote MCP process; keep this gateway available.",
                inputSchema=machine_schema,
            ),
        ]

    def status(self) -> list[dict]:
        return [
            {
                "machine": machine,
                "host": target["host"],
                "state": self.backends[machine].state
                if machine in self.backends
                else "disconnected",
                "error": self.backends[machine].error
                if machine in self.backends
                else None,
            }
            for machine, target in self.targets.items()
        ]

    async def notify(self) -> None:
        for client in list(self.clients):
            try:
                await client.send_tool_list_changed()
            except Exception:
                self.clients.discard(client)

    async def close(self) -> None:
        await asyncio.gather(*(backend.close() for backend in self.backends.values()))

    async def run_stdio(self) -> None:
        async with stdio_server() as (read, write):
            try:
                await self.server.run(
                    read,
                    write,
                    self.server.create_initialization_options(
                        notification_options=NotificationOptions(tools_changed=True)
                    ),
                )
            finally:
                await self.close()

    def http_app(self) -> Starlette:
        manager = StreamableHTTPSessionManager(app=self.server, stateless=False)

        @asynccontextmanager
        async def lifespan(app):
            async with manager.run():
                try:
                    yield
                finally:
                    await self.close()

        class Endpoint:
            async def __call__(self, scope, receive, send):
                await manager.handle_request(scope, receive, send)

        return Starlette(routes=[Route("/mcp", Endpoint())], lifespan=lifespan)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--transport", choices=["stdio", "http"], default="stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    logging.getLogger("mcp").setLevel(logging.WARNING)
    gateway = Gateway(load_targets(args.config.resolve()))
    if args.transport == "stdio":
        asyncio.run(gateway.run_stdio())
    else:
        uvicorn.run(gateway.http_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()

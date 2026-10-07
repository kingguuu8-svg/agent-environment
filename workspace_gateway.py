"""An MCP endpoint bound to one SSH machine and one existing workspace."""

import argparse
import asyncio
import json
import logging
import sys
import weakref
from pathlib import Path
from urllib.parse import quote

import uvicorn
from mcp import types
from mcp.server.lowlevel.helper_types import ReadResourceContents

from gateway import ROOT, Backend, Gateway, GatewayServer, load_targets

CONTEXT_URI = "workspace://context"


class WorkspaceGateway(Gateway):
    def __init__(self, targets: dict[str, dict], machine: str, workspace: str | None):
        if machine not in targets:
            raise ValueError(f"Unknown machine: {machine}")
        target = {
            **targets[machine],
            "workspace": workspace
            if workspace is not None
            else targets[machine]["workspace"],
            "require_existing_workspace": True,
        }
        if not target["workspace"].strip():
            raise ValueError("Workspace path must not be empty")
        self.targets = {machine: target}
        self.machine = machine
        self.backends = {}
        self.lock = asyncio.Lock()
        self.binding: dict | None = None
        self.clients = weakref.WeakSet()
        self.server = GatewayServer("remote-workspace")
        manifest = json.loads((ROOT / "pi-tools.json").read_text())
        self.declared_tools = [
            types.Tool.model_validate(tool) for tool in manifest["tools"]
        ]

        @self.server.list_tools()
        async def list_tools():
            self.clients.add(self.server.request_context.session)
            backend = await self.ensure_connection()
            return backend.tools

        @self.server.call_tool(validate_input=False)
        async def call_tool(name: str, arguments: dict):
            if name not in {tool.name for tool in self.declared_tools}:
                raise ValueError(f"Unknown workspace tool: {name}")
            backend = await self.ensure_connection()
            context = self.server.request_context

            async def progress_callback(progress, total, message):
                await context.session.send_progress_notification(
                    context.meta.progressToken, progress, total, message
                )

            # Reconnect before dispatch only. Retrying a failed write/bash call
            # could execute it twice when the response was lost.
            return await backend.call_tool(
                name,
                arguments,
                progress_callback=progress_callback
                if context.meta and context.meta.progressToken is not None
                else None,
            )

        @self.server.list_resources()
        async def list_resources():
            return [
                types.Resource(
                    uri=CONTEXT_URI,
                    name="Remote workspace context",
                    description="Bound workspace, Git state and Pi project instructions.",
                    mimeType="application/json",
                )
            ]

        @self.server.read_resource()
        async def read_resource(uri):
            if str(uri).startswith("workspace://files?"):
                backend = await self.ensure_connection()
                result = await backend.session.read_resource(uri)
                return [
                    ReadResourceContents(content=item.text, mime_type=item.mimeType)
                    for item in result.contents
                ]
            if str(uri) != CONTEXT_URI:
                raise ValueError(f"Unknown workspace resource: {uri}")
            backend = await self.ensure_connection()
            result = await backend.session.read_resource(CONTEXT_URI)
            context = json.loads(result.contents[0].text)
            if context["workspace"] != self.binding["workspace"]:
                raise RuntimeError("Remote worker returned a different workspace")
            context["binding"] = self.binding
            return [
                ReadResourceContents(
                    content=json.dumps(context), mime_type="application/json"
                )
            ]

    async def ensure_connection(self) -> Backend:
        async with self.lock:
            backend = self.backends.get(self.machine)
            if backend and backend.state == "ready":
                return backend
            if backend:
                await backend.close()
            target = self.targets[self.machine]
            backend = Backend(self, self.machine, target)
            self.backends[self.machine] = backend
            await backend.connect()
            binding = {
                "machine": self.machine,
                "host": target["host"],
                "port": target["port"],
                "workspace": backend.info["workspace"],
                "uri": (
                    f"{'device' if target.get('kind') == 'bridge' else 'ssh'}://{quote(target['host'], safe='@[]:')}:{target['port']}"
                    f"/{quote(backend.info['workspace'].lstrip('/'), safe='/')}"
                ),
            }
            if self.binding is not None and self.binding != binding:
                await backend.close()
                raise RuntimeError("Workspace binding changed on reconnect")
            self.binding = binding
            return backend


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--machine", required=True)
    parser.add_argument("--workspace", help="Existing path on the SSH target")
    parser.add_argument("--transport", choices=["stdio", "http"], default="stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    logging.getLogger("mcp").setLevel(logging.WARNING)
    gateway = WorkspaceGateway(
        load_targets(args.config.resolve()), args.machine, args.workspace
    )
    if args.transport == "stdio":
        asyncio.run(gateway.run_stdio())
    else:
        uvicorn.run(gateway.http_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()

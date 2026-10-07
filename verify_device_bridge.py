"""Exercise native Pi tools through an actual authenticated device bridge."""

import argparse
import asyncio
import json
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

from mcp import StdioServerParameters
from mcp.client.stdio import stdio_client

from gateway import CancellationClientSession
from ssh_fixture import free_port

ROOT = Path(__file__).resolve().parent


async def verify(args, base):
    checks = []

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    token, port = secrets.token_hex(32), free_port()
    alpha, beta = base / "alpha project", base / "beta project"
    for path in [alpha, beta]:
        path.mkdir()
        (path / "AGENTS.md").write_text(path.name + "-instructions")
    config = base / "bridge.json"
    config.write_text(
        json.dumps(
            {
                "token": token,
                "localPort": port,
                "node": args.node,
                "npm": args.npm,
                "workerRoot": str(base / "worker"),
                "path": str(Path(args.node).parent),
            }
        )
    )
    targets = base / "targets.json"
    targets.write_text(
        json.dumps(
            {
                "targets": {
                    "device": {
                        "host": "127.0.0.1",
                        "port": port,
                        "kind": "bridge",
                        "token": token,
                        "node": args.node,
                        "npm": args.npm,
                        "python": sys.executable,
                        "workspace": str(alpha),
                    }
                }
            }
        )
    )
    log = (base / "bridge.log").open("w")
    bridge = subprocess.Popen(
        [sys.executable, str(ROOT / "device_bridge.py"), "--config", str(config)],
        stdout=log,
        stderr=log,
    )

    async def client_stream(workspace):
        params = StdioServerParameters(
            command=sys.executable,
            args=[
                str(ROOT / "workspace_gateway.py"),
                "--config",
                str(targets),
                "--machine",
                "device",
                "--workspace",
                str(workspace),
            ],
        )
        return stdio_client(params)

    def text(result):
        assert not result.isError, result.model_dump_json()
        return "\n".join(item.text for item in result.content if item.type == "text")

    try:
        for _ in range(50):
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                break
            except OSError:
                await asyncio.sleep(0.1)
        else:
            raise AssertionError("Bridge did not start")
        writer.write(
            json.dumps(
                {"token": "wrong", "action": "worker", "workspace": str(alpha)}
            ).encode()
            + b"\n"
        )
        await writer.drain()
        assert "authentication failed" in (await reader.readline()).decode()
        writer.close()
        await writer.wait_closed()
        assert not (base / "worker").exists()
        passed("unauthorized bridge request cannot bootstrap or execute tools")

        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(
            json.dumps({"token": token, "action": "bootstrap"}).encode() + b"\n"
        )
        await writer.drain()
        await asyncio.sleep(10.2)
        writer.write(
            json.dumps(
                {
                    "workspace": str(alpha),
                    "files": {},
                    "npm_registry": "https://registry.npmjs.org",
                }
            ).encode()
            + b"\n"
        )
        await writer.drain()
        response = json.loads(await asyncio.wait_for(reader.readline(), 20))
        assert not response["ok"] and "Unexpected files" in response["error"]
        writer.close()
        await writer.wait_closed()
        passed(
            "authenticated bundle transfer can outlive the short authentication deadline"
        )

        async with (
            await client_stream(alpha) as (read, write),
            CancellationClientSession(read, write) as client,
        ):
            await client.initialize()
            names = {tool.name for tool in (await client.list_tools()).tools}
            assert {"read", "write", "edit", "bash", "grep", "find", "ls"} <= names
            context = json.loads(
                (await client.read_resource("workspace://context")).contents[0].text
            )
            assert context["binding"]["workspace"] == str(alpha)
            assert context["binding"]["uri"].startswith("device://")
            assert "alpha project-instructions" in json.dumps(context)
            passed(
                "bridge bootstraps real Pi tools and returns authoritative native workspace context"
            )
            async with (
                await client_stream(Path("/")) as (root_read, root_write),
                CancellationClientSession(root_read, root_write) as root_client,
            ):
                await root_client.initialize()
                uri = "workspace://files?request=" + quote(
                    json.dumps({"op": "list", "path": str(alpha)}), safe=""
                )
                listed = json.loads(
                    (await root_client.read_resource(uri)).contents[0].text
                )
                assert listed["absolutePath"] == str(alpha)
                assert any(entry["name"] == "AGENTS.md" for entry in listed["entries"])
            passed(
                "Web directory resources cross the bridge from filesystem root to a native workspace"
            )
            text(
                await client.call_tool(
                    "write", {"path": "proof.txt", "content": "BRIDGE-V1\n"}
                )
            )
            text(
                await client.call_tool(
                    "edit", {"path": "proof.txt", "oldText": "V1", "newText": "V2"}
                )
            )
            assert "BRIDGE-V2" in text(
                await client.call_tool("read", {"path": "proof.txt"})
            )
            assert "proof.txt" in text(
                await client.call_tool("find", {"pattern": "*.txt"})
            )
            assert "BRIDGE-V2" in text(
                await client.call_tool("grep", {"pattern": "BRIDGE-V2", "path": "."})
            )
            assert "proof.txt" in text(await client.call_tool("ls", {"path": "."}))
            assert str(alpha) in text(
                await client.call_tool("bash", {"command": "pwd"})
            )
            assert (alpha / "proof.txt").read_text() == "BRIDGE-V2\n"
            passed(
                "all seven tools preserve native execution and independent file side effects"
            )
            async with (
                await client_stream(beta) as (read2, write2),
                CancellationClientSession(read2, write2) as other,
            ):
                await other.initialize()
                text(
                    await other.call_tool(
                        "write", {"path": "proof.txt", "content": "BETA\n"}
                    )
                )
                assert "BRIDGE-V2" in text(
                    await client.call_tool("read", {"path": "proof.txt"})
                )
                assert "BETA" in text(
                    await other.call_tool("read", {"path": "proof.txt"})
                )
            passed("parallel workspaces on one device retain separate roots")
            task = asyncio.create_task(
                client.call_tool(
                    "bash",
                    {
                        "command": "printf STARTED > started.txt; sleep 20; printf FINISHED > finished.txt"
                    },
                )
            )
            for _ in range(50):
                if (alpha / "started.txt").exists():
                    break
                await asyncio.sleep(0.1)
            assert (alpha / "started.txt").exists()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await asyncio.sleep(1)
            assert not (alpha / "finished.txt").exists()
            assert "BRIDGE-V2" in text(
                await client.call_tool("read", {"path": "proof.txt"})
            )
            passed(
                "MCP cancellation crosses the bridge while subsequent calls remain usable"
            )
    finally:
        bridge.terminate()
        bridge.wait(timeout=10)
        log.close()
    return {"checks": checks}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--npm", required=True)
    args = parser.parse_args()
    (ROOT / ".local").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="device-bridge-", dir=ROOT / ".local"
    ) as directory:
        report = asyncio.run(verify(args, Path(directory)))
    (ROOT / ".local/verification-device-bridge.json").write_text(
        json.dumps(report, indent=2)
    )

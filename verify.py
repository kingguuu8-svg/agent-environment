"""Repeatable MCP integration checks against the real SSH gateway."""

import argparse
import asyncio
import json
import sys
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path

from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

ROOT = Path(__file__).resolve().parent


@asynccontextmanager
async def transport(args):
    if args.url:
        async with streamable_http_client(args.url) as streams:
            yield streams[:2]
    else:
        params = StdioServerParameters(
            command=sys.executable,
            args=[str(ROOT / "gateway.py"), "--config", str(args.config.resolve())],
        )
        async with stdio_client(params) as streams:
            yield streams


async def verify(args) -> dict:
    notifications = []
    changed = asyncio.Event()
    checks = []

    def passed(name):
        checks.append(name)
        print(f"PASS {name}", file=sys.stderr, flush=True)

    async def on_message(message):
        notification = message
        if isinstance(notification, types.ServerNotification) and isinstance(
            notification.root, types.ToolListChangedNotification
        ):
            notifications.append(time.monotonic())
            changed.set()

    def data(result):
        assert not result.isError, result.model_dump_json()
        assert result.structuredContent is not None, "Structured output was lost"
        return result.structuredContent

    async with (
        transport(args) as (read, write),
        ClientSession(
            read,
            write,
            read_timeout_seconds=timedelta(seconds=300),
            message_handler=on_message,
        ) as client,
    ):
        initialized = await client.initialize()
        assert initialized.capabilities.tools.listChanged is True
        management = {"list_machines", "connect_machine", "disconnect_machine"}
        data(await client.call_tool("disconnect_machine", {"machine": args.machine}))
        before = {tool.name for tool in (await client.list_tools()).tools}
        native_names = [
            "machine_info",
            "read_file",
            "write_file",
            "edit_file",
            "run_command",
        ]
        machines = data(await client.call_tool("list_machines", {}))["machines"]
        published = management | {
            f"{item['machine']}__{name}" for item in machines for name in native_names
        }
        assert before == published, before
        initial_tools = {tool.name: tool for tool in (await client.list_tools()).tools}
        offline = await client.call_tool(
            f"{args.machine}__read_file", {"path": "proof.txt"}
        )
        assert offline.isError and "connect" in offline.content[0].text
        passed(
            "stable tool contracts are available before installation; calls require connection"
        )

        invalid = await client.call_tool(
            "connect_machine", {"machine": "unknown_machine"}
        )
        assert invalid.isError
        assert {tool.name for tool in (await client.list_tools()).tools} == published
        passed("unknown target is rejected without taking down the gateway")

        if args.denied_machine:
            denied = await client.call_tool(
                "connect_machine", {"machine": args.denied_machine}
            )
            assert denied.isError
            assert "SSH bootstrap failed" in denied.content[0].text
            assert "Permission denied" in denied.content[0].text
            passed("SSH authentication failure leaves management tools available")

        changed.clear()
        connected = data(
            await client.call_tool("connect_machine", {"machine": args.machine})
        )
        assert connected["state"] == "ready"
        await asyncio.wait_for(changed.wait(), timeout=5)
        tools = (await client.list_tools()).tools
        by_name = {tool.name: tool for tool in tools}

        def remote(name):
            return f"{args.machine}__{name}"

        expected = {
            remote(n)
            for n in [
                "machine_info",
                "read_file",
                "write_file",
                "edit_file",
                "run_command",
            ]
        }
        assert expected <= set(by_name) == published
        assert all(by_name[name] == initial_tools[name] for name in expected)
        assert set(by_name[remote("read_file")].inputSchema["properties"]) == {"path"}
        assert by_name[remote("read_file")].outputSchema is not None
        passed(
            "SSH bootstrap discovers native schemas matching the advertised contracts"
        )

        repeated = data(
            await client.call_tool("connect_machine", {"machine": args.machine})
        )
        assert repeated["already_connected"] is True
        passed("repeated connection is idempotent")

        info = data(await client.call_tool(remote("machine_info"), {}))
        data(
            await client.call_tool(
                remote("write_file"),
                {"path": "proof.txt", "content": "first version\n"},
            )
        )
        read_back = data(
            await client.call_tool(remote("read_file"), {"path": "proof.txt"})
        )
        assert read_back["content"] == "first version\n"
        assert read_back["path"].startswith(info["workspace"] + "/")
        data(
            await client.call_tool(
                remote("edit_file"),
                {
                    "path": "proof.txt",
                    "old_text": "first",
                    "new_text": "second",
                },
            )
        )
        read_back = data(
            await client.call_tool(remote("read_file"), {"path": "proof.txt"})
        )
        assert read_back["content"] == "second version\n"
        refused = await client.call_tool(
            remote("edit_file"),
            {
                "path": "proof.txt",
                "old_text": "absent",
                "new_text": "wrong",
            },
        )
        assert refused.isError
        assert (
            data(await client.call_tool(remote("read_file"), {"path": "proof.txt"}))[
                "content"
            ]
            == "second version\n"
        )
        passed(
            "remote write, read, and exact edit preserve structured results and tool errors"
        )

        escape = await client.call_tool(remote("read_file"), {"path": "/etc/passwd"})
        assert escape.isError
        data(
            await client.call_tool(
                remote("run_command"), {"command": "ln -sfn /etc outside_workspace"}
            )
        )
        symlink = await client.call_tool(
            remote("read_file"), {"path": "outside_workspace/passwd"}
        )
        assert symlink.isError
        passed("file tools reject direct and symlink escapes from the workspace")

        command = data(
            await client.call_tool(remote("run_command"), {"command": "pwd; hostname"})
        )
        assert command["exit_code"] == 0
        assert command["stdout"].splitlines() == [info["workspace"], info["hostname"]]
        timed = data(
            await client.call_tool(
                remote("run_command"),
                {
                    "command": "sleep 5",
                    "timeout_seconds": 1,
                },
            )
        )
        assert timed["timed_out"] is True and timed["exit_code"] != 0
        passed("commands execute on the target and timed-out processes are killed")

        # Kill only the PID returned by this connection's remote worker.
        lost = await client.call_tool(
            remote("run_command"),
            {
                "command": f"kill -TERM {int(info['pid'])}",
            },
        )
        assert lost.isError
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            machines = data(await client.call_tool("list_machines", {}))["machines"]
            state = next(
                item["state"] for item in machines if item["machine"] == args.machine
            )
            if state == "failed":
                break
            await asyncio.sleep(0.5)
        assert state == "failed", state
        assert {tool.name for tool in (await client.list_tools()).tools} == published
        unavailable = await client.call_tool(remote("read_file"), {"path": "proof.txt"})
        assert unavailable.isError
        passed(
            "remote process loss refuses calls and keeps contracts and management available"
        )

        recovered = data(
            await client.call_tool("connect_machine", {"machine": args.machine})
        )
        assert recovered["reused_bundle"] is True
        assert (
            data(await client.call_tool(remote("read_file"), {"path": "proof.txt"}))[
                "content"
            ]
            == "second version\n"
        )
        passed("reconnection reuses the bundle and preserves the target's file state")

        data(await client.call_tool("disconnect_machine", {"machine": args.machine}))
        results = await asyncio.gather(
            client.call_tool("connect_machine", {"machine": args.machine}),
            client.call_tool("connect_machine", {"machine": args.machine}),
        )
        assert sum(data(item).get("already_connected", False) for item in results) == 1
        passed("concurrent connects create a single backend")

        data(
            await client.call_tool(
                remote("run_command"),
                {
                    "command": "rm -f proof.txt outside_workspace",
                },
            )
        )
        data(await client.call_tool("disconnect_machine", {"machine": args.machine}))
        assert {tool.name for tool in (await client.list_tools()).tools} == published
        passed("disconnect closes the backend while initialization remains available")
        return {
            "checks_passed": len(checks),
            "checks": checks,
            "transport": "http" if args.url else "stdio",
            "machine": args.machine,
            "target": info,
            "initial_bootstrap_reused": connected["reused_bundle"],
            "tool_list_notifications": len(notifications),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    endpoint = parser.add_mutually_exclusive_group(required=True)
    endpoint.add_argument("--config", type=Path)
    endpoint.add_argument("--url")
    parser.add_argument("--machine", required=True)
    parser.add_argument("--denied-machine")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = asyncio.run(verify(args))
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized + "\n")
    print(serialized)


if __name__ == "__main__":
    main()

"""Repeatable Pi tool and lifecycle checks through the real SSH MCP gateway."""

import argparse
import asyncio
import json
import shlex
import sys
import time
from contextlib import asynccontextmanager, suppress
from datetime import timedelta
from pathlib import Path

from mcp import StdioServerParameters, types
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import McpError

from gateway import CancellationClientSession

ROOT = Path(__file__).resolve().parent
PI_TOOLS = {"read", "write", "edit", "bash", "grep", "find", "ls"}


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


def data(result):
    assert not result.isError, result.model_dump_json()
    assert result.structuredContent is not None, "Structured output was lost"
    return result.structuredContent


def text(result):
    assert not result.isError, result.model_dump_json()
    return "\n".join(item.text for item in result.content if item.type == "text")


async def verify(args) -> dict:
    notifications = []
    changed = asyncio.Event()
    checks = []

    def passed(name):
        checks.append(name)
        print(f"PASS {name}", file=sys.stderr, flush=True)

    async def on_message(message):
        if isinstance(message, types.ServerNotification) and isinstance(
            message.root, types.ToolListChangedNotification
        ):
            notifications.append(time.monotonic())
            changed.set()

    async with (
        transport(args) as (read, write),
        CancellationClientSession(
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
        machines = data(await client.call_tool("list_machines", {}))["machines"]
        published = management | {
            f"{item['machine']}__{name}"
            for item in machines
            for name in PI_TOOLS | {"machine_info"}
        }
        initial = {tool.name: tool for tool in (await client.list_tools()).tools}
        assert set(initial) == published

        def remote(name):
            return f"{args.machine}__{name}"

        async def call(name, arguments):
            return await client.call_tool(remote(name), arguments)

        async def started_pid(path):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                result = await call("read", {"path": path})
                if not result.isError:
                    return int(text(result).strip())
                await asyncio.sleep(0.1)
            raise AssertionError(f"Command did not write {path}")

        async def assert_stopped(pid):
            deadline = time.monotonic() + 5
            while True:
                result = await call(
                    "bash",
                    {"command": f"if kill -0 {pid} 2>/dev/null; then exit 9; fi"},
                )
                if not result.isError:
                    return
                assert time.monotonic() < deadline, f"Command {pid} is still alive"
                await asyncio.sleep(0.1)

        offline = await call("read", {"path": "proof.txt"})
        assert offline.isError and "connect" in offline.content[0].text
        passed(
            "Pi contracts are published before installation; offline calls are rejected"
        )
        invalid = await client.call_tool(
            "connect_machine", {"machine": "unknown_machine"}
        )
        assert invalid.isError
        passed("unknown target leaves the gateway available")
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
        by_name = {tool.name: tool for tool in (await client.list_tools()).tools}
        assert set(by_name) == published
        assert all(by_name[remote(name)] == initial[remote(name)] for name in PI_TOOLS)
        assert set(by_name[remote("read")].inputSchema["properties"]) == {
            "path",
            "offset",
            "limit",
        }
        assert set(by_name[remote("edit")].inputSchema["properties"]) == {
            "path",
            "edits",
        }
        assert by_name[remote("bash")].outputSchema is not None
        info = data(await call("machine_info", {}))
        assert info["provider"] == {
            "name": "@earendil-works/pi-coding-agent",
            "version": "1.0.2",
        }
        passed(
            "installed Pi provider and native contracts match the generated manifest"
        )
        repeated = data(
            await client.call_tool("connect_machine", {"machine": args.machine})
        )
        assert repeated["already_connected"] is True
        passed("repeated connection reuses a single backend")

        text(await call("write", {"path": "proof.txt", "content": "first version\n"}))
        assert text(await call("read", {"path": "proof.txt"})) == "first version\n"
        edited = await call(
            "edit",
            {"path": "proof.txt", "edits": [{"oldText": "first", "newText": "second"}]},
        )
        text(edited)
        assert "second" in edited.meta["pi/details"]["diff"]
        assert "proof.txt" in edited.meta["pi/details"]["patch"]
        refused = await call(
            "edit",
            {"path": "proof.txt", "edits": [{"oldText": "absent", "newText": "wrong"}]},
        )
        assert refused.isError
        assert text(await call("read", {"path": "proof.txt"})) == "second version\n"
        bad = await call("write", {"path": "proof.txt", "content": 5})
        assert bad.isError and "Invalid arguments" in bad.content[0].text
        assert text(await call("read", {"path": "proof.txt"})) == "second version\n"
        passed(
            "Pi edits preserve diffs and reject invalid inputs without changing the file"
        )

        text(
            await call(
                "write",
                {"path": "edge.txt", "content": "\ufeffleft\r\nmiddle\r\nright\r\n"},
            )
        )
        text(
            await call(
                "edit",
                {
                    "path": "edge.txt",
                    "edits": json.dumps(
                        [
                            {"oldText": "left\nmiddle", "newText": "LEFT\nMIDDLE"},
                            {"oldText": "right", "newText": "RIGHT"},
                        ]
                    ),
                },
            )
        )
        raw = data(
            await call(
                "bash",
                {
                    "command": 'node -p \'JSON.stringify(require("fs").readFileSync("edge.txt","utf8"))\''
                },
            )
        )
        assert json.loads(raw["output"]) == "\ufeffLEFT\r\nMIDDLE\r\nRIGHT\r\n"
        overlapping = await call(
            "edit",
            {
                "path": "edge.txt",
                "edits": [
                    {"oldText": "LEFT\nMIDDLE", "newText": "invalid"},
                    {"oldText": "MIDDLE", "newText": "invalid"},
                ],
            },
        )
        assert overlapping.isError
        text(await call("write", {"path": "ambiguous.txt", "content": "same\nsame\n"}))
        ambiguous = await call(
            "edit",
            {
                "path": "ambiguous.txt",
                "edits": [{"oldText": "same", "newText": "changed"}],
            },
        )
        assert ambiguous.isError
        assert text(await call("read", {"path": "ambiguous.txt"})) == "same\nsame\n"
        passed(
            "Pi argument preparation, BOM and CRLF handling, and edit ambiguity rules are preserved"
        )

        text(await call("write", {"path": "concurrent.txt", "content": "one\ntwo\n"}))
        edits = await asyncio.gather(
            *[
                call(
                    "edit",
                    {
                        "path": "concurrent.txt",
                        "edits": [{"oldText": before, "newText": after}],
                    },
                )
                for before, after in [("one", "ONE"), ("two", "TWO")]
            ]
        )
        assert all(not result.isError for result in edits)
        assert text(await call("read", {"path": "concurrent.txt"})) == "ONE\nTWO\n"
        passed("Pi serializes concurrent edits of the same file")

        text(
            await call(
                "write",
                {"path": "../outside.txt", "content": "native path semantics\n"},
            )
        )
        absolute = str(Path(info["workspace"]).parent / "outside.txt")
        assert text(await call("read", {"path": absolute})) == "native path semantics\n"
        data(await call("bash", {"command": "ln -sfn ../outside.txt outside_link"}))
        assert (
            text(await call("read", {"path": "outside_link"}))
            == "native path semantics\n"
        )
        passed(
            "workspace is the default cwd; absolute paths and symlinks retain Pi semantics"
        )

        assert "proof.txt" in text(
            await call("grep", {"pattern": "second version", "path": "."})
        )
        assert "proof.txt" in text(
            await call("find", {"pattern": "*.txt", "path": "."})
        )
        assert "proof.txt" in text(await call("ls", {"path": "."}))
        passed("Pi grep, find and ls search the target filesystem")

        text(
            await call(
                "write",
                {
                    "path": "long.txt",
                    "content": "".join(f"{i}\n" for i in range(1, 2201)),
                },
            )
        )
        truncated = await call("read", {"path": "long.txt"})
        assert "offset=2001" in text(truncated)
        assert truncated.meta["pi/details"]["truncation"]["truncated"] is True
        continued = text(
            await call("read", {"path": "long.txt", "offset": 2001, "limit": 200})
        )
        assert continued.startswith("2001\n") and "\n2200" in continued
        passed("Pi read truncation metadata and offset pagination survive forwarding")

        png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII="
        data(
            await call(
                "bash",
                {
                    "command": 'node -e \'require("fs").writeFileSync("pixel.png",Buffer.from("'
                    + png
                    + '","base64"))\''
                },
            )
        )
        image = await call("read", {"path": "pixel.png"})
        assert not image.isError
        assert any(
            item.type == "image" and item.mimeType == "image/png" and item.data
            for item in image.content
        )
        passed("Pi read image content blocks are preserved")

        command = data(await call("bash", {"command": "pwd\nhostname"}))
        assert command["exit_code"] == 0
        assert command["output"].splitlines() == [info["workspace"], info["hostname"]]
        failed = await call(
            "bash", {"command": "printf 'intentional failure\\n'; exit 7"}
        )
        assert failed.isError and failed.structuredContent["exit_code"] == 7
        passed("Pi bash runs on the target and preserves nonzero exit error results")

        output = await call("bash", {"command": "seq 1 2200"})
        assert data(output)["output"].splitlines() == [str(i) for i in range(1, 2201)]
        assert output.meta["pi/details"]["truncation"]["truncated"] is True
        full_path = output.meta["pi/details"]["fullOutputPath"]
        lines = data(
            await call("bash", {"command": f"wc -l < {shlex.quote(full_path)}"})
        )
        assert int(lines["output"].strip()) == 2200
        data(await call("bash", {"command": f"rm -f {shlex.quote(full_path)}"}))
        passed(
            "Pi bash truncation, structured output and full-output file remain usable"
        )

        progress = []

        async def record_progress(value, total, message):
            progress.append((value, message))

        data(
            await client.call_tool(
                remote("bash"),
                {
                    "command": "printf 'progress started\\n'; sleep 0.4; printf 'progress finished\\n'"
                },
                progress_callback=record_progress,
            )
        )
        assert progress and any(
            "progress started" in (message or "") for _, message in progress
        )
        passed("MCP progress notifications cross both forwarding hops")

        timed = await call(
            "bash", {"command": "echo $$ > timeout.pid; sleep 30", "timeout": 1}
        )
        assert timed.isError and "timed out" in timed.content[0].text
        timeout_pid = int(text(await call("read", {"path": "timeout.pid"})).strip())
        data(
            await call(
                "bash",
                {"command": f"if kill -0 {timeout_pid} 2>/dev/null; then exit 9; fi"},
            )
        )
        passed("Pi timeout returns a tool error and kills the command process")

        try:
            await client.call_tool(
                remote("bash"),
                {"command": "echo $$ > request-timeout.pid; sleep 30"},
                read_timeout_seconds=timedelta(seconds=1),
            )
        except McpError as error:
            assert error.error.code == 408
        else:
            raise AssertionError("The MCP request did not time out")
        await assert_stopped(await started_pid("request-timeout.pid"))
        passed("MCP request timeout propagates cancellation to the target process")

        pending = asyncio.create_task(
            call("bash", {"command": "echo $$ > cancelled.pid; sleep 30"})
        )
        try:
            deadline = time.monotonic() + 5
            cancel_pid = None
            while time.monotonic() < deadline:
                started = await call("read", {"path": "cancelled.pid"})
                if not started.isError:
                    cancel_pid = int(text(started).strip())
                    break
                await asyncio.sleep(0.1)
            assert cancel_pid is not None, "The cancellable command did not start"
            pending.cancel()
            with suppress(asyncio.CancelledError):
                await pending
            deadline = time.monotonic() + 5
            while True:
                stopped = await call(
                    "bash",
                    {
                        "command": f"if kill -0 {cancel_pid} 2>/dev/null; then exit 9; fi"
                    },
                )
                if not stopped.isError:
                    break
                assert time.monotonic() < deadline, "Cancelled command is still alive"
                await asyncio.sleep(0.1)
        finally:
            if not pending.done():
                pending.cancel()
                with suppress(asyncio.CancelledError):
                    await pending
        passed("MCP cancellation reaches Pi and stops the remote command")

        lost = await call("bash", {"command": f"kill -TERM {int(info['pid'])}"})
        assert lost.isError
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            machines = data(await client.call_tool("list_machines", {}))["machines"]
            state = next(
                item["state"] for item in machines if item["machine"] == args.machine
            )
            if state == "failed":
                break
            await asyncio.sleep(0.2)
        assert state == "failed", state
        assert (await call("read", {"path": "proof.txt"})).isError
        assert {tool.name for tool in (await client.list_tools()).tools} == published
        passed(
            "worker loss rejects execution and keeps tool contracts and management available"
        )
        recovered = data(
            await client.call_tool("connect_machine", {"machine": args.machine})
        )
        assert recovered["reused_bundle"] is True
        assert text(await call("read", {"path": "proof.txt"})) == "second version\n"
        passed("reconnection reuses the Pi bundle and preserves target files")
        data(await client.call_tool("disconnect_machine", {"machine": args.machine}))
        results = await asyncio.gather(
            *[
                client.call_tool("connect_machine", {"machine": args.machine})
                for _ in range(2)
            ]
        )
        assert sum(data(item).get("already_connected", False) for item in results) == 1
        passed("concurrent connects create one backend")
        data(
            await call(
                "bash",
                {
                    "command": "rm -f proof.txt edge.txt ambiguous.txt concurrent.txt long.txt pixel.png timeout.pid request-timeout.pid cancelled.pid outside_link ../outside.txt"
                },
            )
        )
        pending = asyncio.create_task(
            call("bash", {"command": "echo $$ > disconnect.pid; sleep 30"})
        )
        try:
            disconnect_pid = await started_pid("disconnect.pid")
            data(
                await client.call_tool("disconnect_machine", {"machine": args.machine})
            )
            assert (await asyncio.wait_for(pending, timeout=10)).isError
            data(await client.call_tool("connect_machine", {"machine": args.machine}))
            await assert_stopped(disconnect_pid)
            data(await call("bash", {"command": "rm -f disconnect.pid"}))
        finally:
            if not pending.done():
                pending.cancel()
                with suppress(asyncio.CancelledError):
                    await pending
        passed("disconnect aborts the in-flight Pi command before reconnecting")
        data(await client.call_tool("disconnect_machine", {"machine": args.machine}))
        assert {tool.name for tool in (await client.list_tools()).tools} == published
        passed("disconnect closes the worker and keeps declared tools available")
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
    serialized = (
        json.dumps(asyncio.run(verify(args)), ensure_ascii=False, indent=2) + "\n"
    )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized)
    print(serialized)


if __name__ == "__main__":
    main()

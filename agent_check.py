"""Use an existing OpenCode client to exercise cold-start dynamic MCP tools."""

import argparse
import asyncio
import json
import os
import subprocess
from datetime import timedelta
from pathlib import Path

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

ROOT = Path(__file__).resolve().parent
PROOF = "agent used remote MCP tools\n"


async def confirm(url, machine):
    async with (
        streamable_http_client(url) as (read, write, _),
        ClientSession(
            read, write, read_timeout_seconds=timedelta(seconds=30)
        ) as client,
    ):
        await client.initialize()
        result = await client.call_tool(f"{machine}__read", {"path": "agent-proof.txt"})
        assert not result.isError
        assert (
            "\n".join(item.text for item in result.content if item.type == "text")
            == PROOF
        )
        await client.call_tool(f"{machine}__bash", {"command": "rm -f agent-proof.txt"})
        await client.call_tool("disconnect_machine", {"machine": machine})


def check(url, machine, model):
    directory = ROOT / ".local/agent-check"
    directory.mkdir(parents=True, exist_ok=True)
    config = directory / "opencode.json"
    config.write_text(
        json.dumps(
            {
                "mcp": {
                    "demo": {
                        "type": "remote",
                        "url": url,
                        "enabled": True,
                        "timeout": 180000,
                    }
                },
                "permission": {"*": "deny", "demo_*": "allow"},
            },
            indent=2,
        )
    )
    env = os.environ.copy()
    env["OPENCODE_CONFIG"] = str(config)
    prompt = (
        f"Verify the demo remote MCP tools using only demo tools. "
        f"First call list_machines and connect_machine with machine={machine}. "
        f"After a successful connection, use {machine}__machine_info, "
        f"{machine}__write to write agent-proof.txt containing exactly "
        f"'agent used native MCP tools\\n', then {machine}__edit with edits[] replacing 'native' with 'remote'. "
        f"Read the file to confirm. Use {machine}__grep to find 'remote' in agent-proof.txt, "
        f"{machine}__find to find agent-proof.txt, and {machine}__ls to list the workspace. "
        f"Run {machine}__bash with 'pwd; hostname' to confirm "
        "the actual target. Finish by reporting the hostname and verified file content. "
        "Do not use local tools or delegate. If newly connected tools remain unavailable, "
        "report that limitation instead of claiming success."
    )
    with (
        (directory / "events.jsonl").open("w") as stdout,
        (directory / "stderr.log").open("w") as stderr,
    ):
        result = subprocess.run(
            [
                "opencode",
                "run",
                "--pure",
                "--model",
                model,
                "--format",
                "json",
                "--dir",
                str(directory),
                "--title",
                "Remote MCP cold-start verification",
                prompt,
            ],
            stdout=stdout,
            stderr=stderr,
            env=env,
            timeout=240,
            check=False,
        )
    calls = []
    error_types = []
    for line in (directory / "events.jsonl").read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "tool_use":
            part = event["part"]
            calls.append({"tool": part["tool"], "status": part["state"]["status"]})
        elif event.get("type") == "error":
            error_types.append(event.get("error", {}).get("name", "error"))
    completed = {item["tool"] for item in calls if item["status"] == "completed"}
    required = {"demo_connect_machine"} | {
        f"demo_{machine}__{name}"
        for name in (
            "machine_info",
            "write",
            "edit",
            "read",
            "bash",
            "grep",
            "find",
            "ls",
        )
    }
    report = {
        "client": "opencode",
        "model": model,
        "exit_code": result.returncode,
        "tool_calls": calls,
        "error_types": error_types,
        "cold_start_tools_available": required <= completed,
    }
    (directory / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    if result.returncode or not required <= completed:
        raise RuntimeError("Agent check failed: " + json.dumps(report))
    asyncio.run(confirm(url, machine))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--machine", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.url, args.machine, args.model), indent=2))

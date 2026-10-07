"""Verify remote workspace sessions through an isolated local SSH server."""

import argparse
import asyncio
import json
import socket
import subprocess
import sys
import time

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from ssh_fixture import ROOT, SSHFixture, free_port

WORKSPACE_SETUP = """
import json,pathlib,subprocess,sys
base=pathlib.Path(json.load(sys.stdin)['base']).expanduser().resolve()
base.mkdir(parents=True,exist_ok=True)
(base/'AGENTS.md').write_text('Inherited project instruction: shared-context-token\\n')
paths=[]
for name in ('alpha','beta'):
    path=base/(name+' project')
    path.mkdir()
    (path/'AGENTS.md').write_text('Current project marker: '+name+'-marker-v1\\n')
    subprocess.run(['git','init','--quiet','--initial-branch='+name,str(path)],check=True)
    paths.append(str(path))
print(json.dumps(paths))
"""


async def confirm_http(url, workspace):
    async with (
        streamable_http_client(url) as (read, write, _),
        ClientSession(read, write) as client,
    ):
        await client.initialize()
        context = await client.read_resource("workspace://context")
        assert json.loads(context.contents[0].text)["binding"]["workspace"] == workspace
        result = await client.call_tool("read", {"path": "proof.txt"})
        assert not result.isError and result.content[0].text == "ALPHA\n"


def verify_http(fixture, args, workspace, local):
    port = free_port()
    with (fixture.directory / "http.log").open("w") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "workspace_gateway.py"),
                "--config",
                str(fixture.config),
                "--machine",
                "laptop",
                "--workspace",
                workspace,
                "--transport",
                "http",
                "--port",
                str(port),
            ],
            stdout=log,
            stderr=log,
        )
        try:
            for _ in range(50):
                if process.poll() is not None:
                    raise RuntimeError(
                        (fixture.directory / "http.log").read_text()[-3000:]
                    )
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Workspace HTTP gateway did not start")
            url = f"http://127.0.0.1:{port}/mcp"
            result = subprocess.check_output(
                [
                    args.node,
                    str(ROOT / "remote-agent.mjs"),
                    "--url",
                    url,
                    "--inspect",
                    "--state-dir",
                    str(fixture.directory / "state"),
                    "--agent-dir",
                    str(fixture.directory / "pi-agent"),
                ],
                text=True,
                cwd=local,
                timeout=60,
            )
            assert json.loads(result)["binding"]["workspace"] == workspace
            asyncio.run(confirm_http(url, workspace))
        finally:
            process.terminate()
            process.wait(timeout=15)
    print(
        "PASS workspace HTTP resources, native read and --url CLI inspection",
        flush=True,
    )
    report_path = ROOT / ".local/verification-workspace-local.json"
    report = json.loads(report_path.read_text())
    report["checks"].append(
        "workspace HTTP resources, native read and --url CLI inspection"
    )
    report_path.write_text(json.dumps(report, indent=2) + "\n")


def run(args):
    with SSHFixture(node=args.node, npm=args.npm) as fixture:
        paths = json.loads(
            subprocess.check_output(
                ["python3", "-c", WORKSPACE_SETUP],
                input=json.dumps({"base": str(fixture.target_root / "projects")}),
                text=True,
            )
        )
        local = fixture.directory / "agent-workspace"
        local.mkdir()
        (local / "AGENTS.md").write_text("local-context-token\n")
        subprocess.run(
            [
                args.node,
                str(ROOT / "verify_workspace.mjs"),
                "--config",
                str(fixture.config),
                "--machine",
                "laptop",
                "--workspace-a",
                paths[0],
                "--workspace-b",
                paths[1],
                "--state-dir",
                str(fixture.directory / "state"),
                "--agent-dir",
                str(fixture.directory / "pi-agent"),
                "--output",
                str(ROOT / ".local/verification-workspace-local.json"),
            ],
            cwd=local,
            check=True,
            timeout=300,
        )
        verify_http(fixture, args, paths[0], local)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    run(parser.parse_args())

"""Use a real DSH model to discover a previously unknown HTTP MCP tool."""

import argparse
import json
import os
import signal
import subprocess
import sys
import uuid
from pathlib import Path

from ssh_fixture import free_port
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent


def run(args):
    run_id = uuid.uuid4().hex[:12]
    base = ROOT / ".local" / ("dsh-mcp-" + run_id)
    workspace = base / "workspace"
    workspace.mkdir(parents=True, mode=0o700)
    mcp_port, web_port = free_port(), free_port()
    tool = "probe_" + run_id
    server = base / "fixture.py"
    receipt = workspace / "receipt.json"
    server.write_text(
        "from mcp.server.fastmcp import FastMCP\nimport json,pathlib\n"
        f"m=FastMCP('diagnostic',host='127.0.0.1',port={mcp_port})\n"
        f"@m.tool(name={tool!r},description='Check MCP connectivity by returning a fixed success marker.')\n"
        "def probe(message:str)->str:\n"
        f" pathlib.Path({str(receipt)!r}).write_text(json.dumps({{'message':message}}))\n"
        " return 'MCP-DISCOVERY-OK'\n"
        "m.run(transport='streamable-http')\n"
    )
    targets = base / "targets.json"
    targets.write_text(
        json.dumps(
            {
                "targets": {},
                "mcp": {"fixture_mcp": {"url": f"http://127.0.0.1:{mcp_port}/mcp"}},
            }
        )
    )
    subprocess.run(
        [
            args.node,
            str(ROOT / "configure-dsh.mjs"),
            "--home",
            str(base / "home"),
            "--state",
            str(base / "state"),
            "--workspace",
            str(workspace),
            "--targets",
            str(targets),
            "--python",
            sys.executable,
            "--model",
            str(args.models.resolve()),
        ],
        check=True,
    )
    credential = args.model_env.read_text().strip().split("=", 1)[1]
    environment = {
        **os.environ,
        "REMOTE_MCP_CHECK_API_KEY": json.loads(credential)
        if credential.startswith('"')
        else credential,
    }
    processes = []
    with (base / "runtime.log").open("w") as log:
        try:
            processes.append(
                subprocess.Popen(
                    [sys.executable, str(server)],
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )
            )
            processes.append(
                subprocess.Popen(
                    [
                        args.node,
                        str(ROOT / "dsh-host.mjs"),
                        "--home",
                        str(base / "home"),
                        "--state",
                        str(base / "state"),
                        "--workspace",
                        str(workspace),
                        "--port",
                        str(web_port),
                    ],
                    stdout=log,
                    stderr=log,
                    env=environment,
                    start_new_session=True,
                )
            )

            def login():
                launch = base / "state/web-url.json"
                if not launch.exists():
                    raise RuntimeError("DSH fixture is starting")
                return DshApi(json.loads(launch.read_text())["url"])

            api = wait_for(login, timeout=30)
            wait_for(lambda: api.remote("catalog", {}), timeout=30)
            picked = api.remote(
                "pick", {"machine": "cloud", "workspace": str(workspace)}
            )
            session = api.rpc("session/create", {"request": {"cwd": picked["cwd"]}})[
                "sessionId"
            ]
            client = str(uuid.uuid4())
            controlled = api.remote(
                "control", {"sessionId": session, "clientId": client}
            )
            prompt = "First use environment to list services and their actual tool schemas. Discover the diagnostic tool on fixture_mcp and call it with message set to discovery-ok. Use write on the current workspace to save exactly its success marker in proof.txt. The diagnostic tool name must come from discovery."
            api.remote(
                "input",
                {
                    "clientId": client,
                    "epoch": controlled["control"]["epoch"],
                    "method": "prompt",
                    "payload": {
                        "sessionId": session,
                        "requestId": str(uuid.uuid4()),
                        "mode": "queue",
                        "content": [{"type": "text", "text": prompt}],
                    },
                },
            )
            wait_for(
                lambda: api.read(session, "proof.txt"),
                lambda value: value["text"].strip() == "MCP-DISCOVERY-OK",
            )
            wait_for(
                lambda: api.remote("get", {"sessionId": session}),
                lambda value: not value["running"],
            )
            assert json.loads(receipt.read_text()) == {"message": "discovery-ok"}
            assert (
                api.remote("get", {"sessionId": session})["current"]["machine"]
                == "cloud"
            )
            report = {
                "checks": [
                    "real model discovers and invokes a new HTTP MCP tool",
                    "explicit service call preserves default workspace",
                ],
                "sessionId": session,
                "fixtureTool": tool,
            }
            (ROOT / ".local/verification-dsh-mcp.json").write_text(
                json.dumps(report, indent=2)
            )
            print(
                "PASS real model discovers an unknown HTTP MCP tool, invokes it and retains the default workspace",
                flush=True,
            )
        finally:
            for process in reversed(processes):
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--model-env", type=Path, required=True)
    parser.add_argument("--node", default="node")
    run(parser.parse_args())

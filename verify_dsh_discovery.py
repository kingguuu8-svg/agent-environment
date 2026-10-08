"""Verify partial MCP discovery, cancellation and recovery in a real isolated DSH Host."""

import argparse
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from device_onboarding import save
from ssh_fixture import SSHFixture, free_port
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent


def text(content):
    return (
        content
        if isinstance(content, str)
        else "\n".join(item.get("text", "") for item in content)
    )


class FixtureModel(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(payload)
        messages = payload["messages"]
        last_user = max(i for i, item in enumerate(messages) if item["role"] == "user")
        marker = text(messages[last_user]["content"])
        results = [item for item in messages[last_user + 1 :] if item["role"] == "tool"]
        if not results:
            name, args = "environment", {"action": "list"}
        elif len(results) == 1:
            listing = json.loads(text(results[0]["content"]))
            target = next(
                item
                for item in listing
                if item["id"]
                == ("stalled_service" if "RECOVER" in marker else "ready_service")
            )
            name, args = (
                "environment",
                {
                    "action": "call",
                    "target": target["id"],
                    "tool": target["tools"][0]["name"],
                    "args": {"message": marker},
                },
            )
        elif len(results) == 2:
            name, args = "read", {"path": "AGENTS.md"}
        else:
            name = None
        if name:
            delta = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "discovery-" + uuid.uuid4().hex,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)},
                    }
                ],
            }
            finish = "tool_calls"
        else:
            delta, finish = (
                {"role": "assistant", "content": "DISCOVERY-DONE:" + marker},
                "stop",
            )
        chunks = [
            {"delta": delta, "finish_reason": None},
            {"delta": {}, "finish_reason": finish},
        ]
        body = (
            "".join(
                "data: "
                + json.dumps(
                    {
                        "id": "chatcmpl-discovery",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "discovery-fixture",
                        "choices": [{"index": 0, **chunk}],
                    }
                )
                + "\n\n"
                for chunk in chunks
            )
            + "data: [DONE]\n\n"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run(args):
    checks, timings = [], {}
    FixtureModel.requests = []
    with (
        SSHFixture(node=args.node, npm=args.npm) as ssh,
        tempfile.TemporaryDirectory(
            prefix="dsh-discovery-", dir=ROOT / ".local"
        ) as directory,
        ThreadingHTTPServer(("127.0.0.1", 0), FixtureModel) as model,
    ):
        base = Path(directory)
        cloud, remote = base / "cloud project", ssh.target_root / "workspace"
        cloud.mkdir()
        remote.mkdir()
        (cloud / "AGENTS.md").write_text("CLOUD-DISCOVERY-PROJECT\n")
        (remote / "AGENTS.md").write_text("REMOTE-DISCOVERY-PROJECT\n")
        threading.Thread(target=model.serve_forever, daemon=True).start()
        host = None
        with (base / "runtime.log").open("a") as log:
            fixture = subprocess.Popen(
                [
                    args.node,
                    str(ROOT / "mcp_discovery_fixture.mjs"),
                    str(base / "mcp.json"),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
                start_new_session=True,
            )

            def fixture_reply():
                assert select.select([fixture.stdout], [], [], 5)[0], (
                    "MCP fixture did not respond"
                )
                return json.loads(fixture.stdout.readline())

            def fixture_command(action):
                fixture.stdin.write(json.dumps({"action": action}) + "\n")
                fixture.stdin.flush()
                return fixture_reply()

            def passed(name):
                checks.append(name)
                print("PASS " + name, flush=True)

            def stop():
                nonlocal host
                if host and host.poll() is None:
                    os.killpg(host.pid, signal.SIGTERM)
                    try:
                        host.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(host.pid, signal.SIGKILL)
                        host.wait()
                host = None

            try:
                assert fixture_reply()["ready"]
                configuration = json.loads(ssh.config.read_text())
                configuration["mcp"] = json.loads((base / "mcp.json").read_text())[
                    "mcp"
                ]
                save(ssh.config, configuration)
                save(
                    base / "models.json",
                    {
                        "providers": {
                            "fixture": {
                                "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                                "api": "openai-completions",
                                "models": [
                                    {
                                        "id": "discovery-fixture",
                                        "reasoning": False,
                                        "contextWindow": 128000,
                                        "maxTokens": 1024,
                                        "compat": {
                                            "supportsDeveloperRole": False,
                                            "supportsStore": False,
                                        },
                                    }
                                ],
                            }
                        }
                    },
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
                        str(cloud),
                        "--targets",
                        str(ssh.config),
                        "--python",
                        sys.executable,
                        "--model",
                        str(base / "models.json"),
                    ],
                    check=True,
                    stdout=log,
                    stderr=log,
                )
                port = free_port()

                def start():
                    nonlocal host
                    (base / "state/web-url.json").unlink(missing_ok=True)
                    host = subprocess.Popen(
                        [
                            args.node,
                            str(ROOT / "dsh-host.mjs"),
                            "--home",
                            str(base / "home"),
                            "--state",
                            str(base / "state"),
                            "--workspace",
                            str(cloud),
                            "--port",
                            str(port),
                        ],
                        stdout=log,
                        stderr=log,
                        start_new_session=True,
                        env={
                            **os.environ,
                            "REMOTE_MCP_CHECK_API_KEY": "unused-fixture-key",
                        },
                    )

                    def ready():
                        launch = base / "state/web-url.json"
                        if not launch.exists():
                            raise RuntimeError("Discovery Host is starting")
                        api = DshApi(json.loads(launch.read_text())["url"])
                        api.remote("catalog", {})
                        return api

                    return wait_for(ready, timeout=30)

                api = start()
                sessions, controls = {}, {}
                for machine, workspace in [("cloud", cloud), ("laptop", remote)]:
                    picked = api.remote(
                        "pick", {"machine": machine, "workspace": str(workspace)}
                    )
                    session = api.rpc(
                        "session/create",
                        {"request": {"workspaceId": picked["workspaceId"]}},
                    )["sessionId"]
                    client = str(uuid.uuid4())
                    control = api.remote(
                        "control",
                        {
                            "sessionId": session,
                            "clientId": client,
                            "label": machine + " fixture",
                        },
                    )
                    sessions[machine], controls[machine] = (
                        session,
                        {"clientId": client, "epoch": control["control"]["epoch"]},
                    )

                def view(machine):
                    return api.remote(
                        "get",
                        {
                            "sessionId": sessions[machine],
                            "clientId": controls[machine]["clientId"],
                        },
                    )

                def prompt(machine, marker):
                    api.remote(
                        "input",
                        {
                            **controls[machine],
                            "method": "prompt",
                            "payload": {
                                "sessionId": sessions[machine],
                                "requestId": str(uuid.uuid4()),
                                "mode": "queue",
                                "content": [{"type": "text", "text": marker}],
                            },
                        },
                    )

                before = view("laptop")
                prompt("cloud", "CANCEL-DISCOVERY")
                wait_for(
                    lambda: fixture_command("status"),
                    lambda value: any(
                        item["method"] == "notifications/initialized"
                        for item in value["requests"]["stalled_service"]
                    ),
                    timeout=10,
                )
                started = time.monotonic()
                prompt("laptop", "PARTIAL-DISCOVERY")
                wait_for(
                    lambda: FixtureModel.requests,
                    lambda requests: any(
                        "PARTIAL-DISCOVERY" in str(item["messages"])
                        for item in requests
                    ),
                    timeout=10,
                )
                cancelling = time.monotonic()
                api.remote(
                    "input",
                    {
                        **controls["cloud"],
                        "method": "cancel",
                        "payload": {"sessionId": sessions["cloud"]},
                    },
                )
                wait_for(
                    lambda: view("cloud"), lambda value: not value["running"], timeout=3
                )
                timings["cancellationSeconds"] = time.monotonic() - cancelling
                assert timings["cancellationSeconds"] < 2
                assert view("laptop")["running"]
                passed(
                    "native session cancellation returns promptly without cancelling another session's discovery"
                )
                wait_for(
                    lambda: view("laptop"),
                    lambda value: not value["running"],
                    timeout=20,
                )
                timings["partialTurnSeconds"] = time.monotonic() - started
                assert timings["partialTurnSeconds"] < 15
                service_state = fixture_command("status")
                assert len(service_state["calls"]["ready_service"]) == 1
                assert service_state["calls"]["ready_service"][0]["arguments"] == {
                    "message": "PARTIAL-DISCOVERY"
                }
                assert (
                    sum(
                        item["method"] == "initialize"
                        for item in service_state["requests"]["stalled_service"]
                    )
                    == 1
                )
                passed(
                    "actual model HTTP flow discovers complete healthy schemas and calls that service despite a stalled peer"
                )
                request = FixtureModel.requests[-1]
                listing = json.loads(
                    text(
                        next(
                            item["content"]
                            for item in request["messages"]
                            if item["role"] == "tool"
                        )
                    )
                )
                assert (
                    len(
                        next(
                            item["tools"]
                            for item in listing
                            if item["id"] == "ready_service"
                        )
                    )
                    == 2
                )
                stalled = next(
                    item for item in listing if item["id"] == "stalled_service"
                )
                assert stalled["availability"] == "unavailable" and not stalled["tools"]
                assert "timed out after 12 seconds" in stalled["error"]
                assert "REMOTE-DISCOVERY-PROJECT" in str(request["messages"])
                after = view("laptop")
                assert all(
                    before[key] == after[key]
                    for key in ["current", "pending", "revision", "control"]
                )
                assert api.read(sessions["laptop"], "AGENTS.md")[
                    "text"
                ].splitlines() == ["REMOTE-DISCOVERY-PROJECT"]
                passed(
                    "partial failure reaches the model while SSH workspace, project instructions, files and input ownership stay intact"
                )

                fixture_command("recover")
                prompt("laptop", "RECOVER-DISCOVERY")
                wait_for(
                    lambda: view("laptop"),
                    lambda value: not value["running"],
                    timeout=10,
                )
                assert fixture_command("status")["calls"]["stalled_service"][0][
                    "arguments"
                ] == {"message": "RECOVER-DISCOVERY"}
                assert all(
                    before[key] == view("laptop")[key]
                    for key in ["current", "pending", "revision", "control"]
                )
                assert "PARTIAL-DISCOVERY" in str(FixtureModel.requests[-1]["messages"])
                passed(
                    "same cloud conversation retries the recovered service and retains earlier cross-device history"
                )

                def session_snapshot():
                    fields = [
                        "title",
                        "sessionStats",
                        "remoteBinding",
                        "remoteController",
                        "agentPreset",
                    ]
                    return {
                        item["sessionId"]: {
                            "cwd": item["cwd"],
                            "projections": {
                                key: item["projections"]["values"][key]
                                for key in fields
                            },
                        }
                        for item in api.rpc("session/list", {"_request": {}})["items"]
                    }

                saved = session_snapshot()
                stop()
                api = start()
                assert session_snapshot() == saved
                assert view("laptop")["control"]["mine"]
                assert view("laptop")["current"] == before["current"]
                controls["laptop"]["epoch"] = view("laptop")["control"]["epoch"]
                prompt("laptop", "RESTART-DISCOVERY")
                wait_for(
                    lambda: view("laptop"),
                    lambda value: not value["running"],
                    timeout=10,
                )
                assert "RECOVER-DISCOVERY" in str(FixtureModel.requests[-1]["messages"])
                passed(
                    "Host restart preserves sessions, service identities, default target and cloud conversation continuity"
                )
                report = {
                    "checks": checks,
                    "timings": timings,
                    "modelRequests": len(FixtureModel.requests),
                }
                save(ROOT / ".local/verification-dsh-discovery.json", report)
                print(json.dumps(report), flush=True)
            finally:
                stop()
                if fixture.poll() is None:
                    fixture.stdin.write('{"action":"quit"}\n')
                    fixture.stdin.flush()
                    try:
                        fixture.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(fixture.pid, signal.SIGKILL)
                        fixture.wait()
                fixture.stdin.close()
                fixture.stdout.close()
                model.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    run(parser.parse_args())

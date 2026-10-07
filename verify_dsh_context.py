"""Inspect actual model HTTP requests before and after native workspace switches."""

import argparse
import concurrent.futures
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ssh_fixture import SSHFixture, free_port
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent


def run(args):
    run_id = uuid.uuid4().hex[:12]
    base = ROOT / ".local" / ("dsh-context-" + run_id)
    cloud = base / "cloud"
    cloud.mkdir(parents=True, mode=0o700)
    cloud_marker, remote_marker = "CLOUD-" + run_id, "REMOTE-" + run_id
    (cloud / "AGENTS.md").write_text(
        cloud_marker + "\nKeep {{cloud-template}} literal.\n"
    )
    requests = []

    class Recorder(BaseHTTPRequestHandler):
        def log_message(self, *arguments):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(payload)
            chunks = [
                {
                    "delta": {"role": "assistant", "content": "CONTEXT-WIRE-OK"},
                    "finish_reason": None,
                },
                {"delta": {}, "finish_reason": "stop"},
            ]
            body = (
                "".join(
                    "data: "
                    + json.dumps(
                        {
                            "id": "chatcmpl-context-" + run_id,
                            "object": "chat.completion.chunk",
                            "created": 1,
                            "model": "context-fixture",
                            "choices": [{"index": 0, **chunk}],
                        }
                    )
                    + "\n\n"
                    for chunk in chunks
                )
                + "data: [DONE]\n\n"
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body.encode())))
            self.end_headers()
            self.wfile.write(body.encode())

    recorder = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    thread = threading.Thread(target=recorder.serve_forever, daemon=True)
    thread.start()
    host = None
    checks = []

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    try:
        with SSHFixture(node=args.node, npm=args.npm) as fixture:
            remote = fixture.target_root / "workspace"
            remote.mkdir()
            instructions = remote / "AGENTS.md"
            instructions.write_text(
                remote_marker + "\nKeep {{remote-template}} literal.\n"
            )
            subprocess.run(["git", "init", "--quiet", str(remote)], check=True)
            configuration = json.loads(fixture.config.read_text())
            configuration["targets"]["slow"] = dict(configuration["targets"]["laptop"])
            fixture.config.write_text(json.dumps(configuration))
            models = base / "models.json"
            models.write_text(
                json.dumps(
                    {
                        "providers": {
                            "fixture": {
                                "baseUrl": f"http://127.0.0.1:{recorder.server_port}/v1",
                                "api": "openai-completions",
                                "models": [
                                    {
                                        "id": "context-fixture",
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
                    str(cloud),
                    "--targets",
                    str(fixture.config),
                    "--python",
                    sys.executable,
                    "--model",
                    str(models),
                ],
                check=True,
            )
            with (base / "runtime.log").open("w") as log:
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
                        str(free_port()),
                    ],
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                    env={
                        **os.environ,
                        "REMOTE_MCP_CHECK_API_KEY": "context-fixture-key",
                    },
                )

                def login():
                    launch = base / "state/web-url.json"
                    if not launch.exists():
                        raise RuntimeError("DSH context fixture is starting")
                    return DshApi(json.loads(launch.read_text())["url"])

                api = wait_for(login, timeout=30)
                wait_for(lambda: api.remote("catalog", {}), timeout=30)
                picked = api.remote(
                    "pick", {"machine": "cloud", "workspace": str(cloud)}
                )
                expected_title = f"{socket.gethostname()} · {cloud.name}"
                assert picked["title"] == expected_title
                registered = api.rpc(
                    "workspace/create", {"request": {"path": picked["cwd"]}}
                )
                assert (
                    registered["workspace"]["title"] == expected_title
                    and not registered["created"]
                )
                passed(
                    "workspace selection registers a complete host-and-folder name before returning"
                )
                api.rpc(
                    "workspace/rename",
                    {
                        "request": {
                            "workspaceId": picked["workspaceId"],
                            "title": Path(picked["cwd"]).name,
                        }
                    },
                )
                with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                    repeated = list(
                        pool.map(
                            lambda _: api.remote(
                                "pick", {"machine": "cloud", "workspace": str(cloud)}
                            ),
                            range(3),
                        )
                    )
                assert all(
                    value["workspaceId"] == picked["workspaceId"]
                    and value["title"] == expected_title
                    for value in repeated
                )
                passed(
                    "repeated parallel selection reuses the workspace and repairs a partial legacy name"
                )
                session = api.rpc(
                    "session/create",
                    {"request": {"workspaceId": picked["workspaceId"]}},
                )["sessionId"]
                client = str(uuid.uuid4())
                control = api.remote(
                    "control", {"sessionId": session, "clientId": client}
                )
                epoch = control["control"]["epoch"]

                def get():
                    return api.remote("get", {"sessionId": session, "clientId": client})

                def prompt():
                    count = len(requests)
                    api.remote(
                        "input",
                        {
                            "clientId": client,
                            "epoch": epoch,
                            "method": "prompt",
                            "payload": {
                                "sessionId": session,
                                "requestId": str(uuid.uuid4()),
                                "mode": "queue",
                                "content": [
                                    {
                                        "type": "text",
                                        "text": "Reply exactly CONTEXT-WIRE-OK. Do not use tools.",
                                    }
                                ],
                            },
                        },
                    )
                    wait_for(lambda: len(requests) > count, timeout=30)
                    wait_for(get, lambda value: not value["running"], timeout=30)
                    assert len(requests) == count + 1, "Unexpected model retry"
                    body = requests[-1]
                    systems = [
                        m["content"]
                        for m in body["messages"]
                        if m["role"] in {"system", "developer"}
                    ]
                    assert len(systems) == 1, "Expected one effective system prompt"
                    assert isinstance(systems[0], str)
                    assert (
                        "Current execution environment (authoritative for this request):"
                        in systems[0]
                    )
                    return systems[0]

                def switch(machine, workspace):
                    return api.remote(
                        "switch",
                        {
                            "sessionId": session,
                            "clientId": client,
                            "epoch": epoch,
                            "revision": get()["revision"],
                            "machine": machine,
                            "workspace": str(workspace),
                        },
                    )

                first = prompt()
                assert "Machine: cloud" in first and f"Workspace: {cloud}" in first
                assert cloud_marker in first and "{{cloud-template}}" in first
                assert "Binding revision: 0." in first
                passed(
                    "authoritative workspace reaches the actual model HTTP system prompt"
                )

                switch("laptop", remote)
                second = prompt()
                assert "Machine: laptop" in second and f"Workspace: {remote}" in second
                assert remote_marker in second and cloud_marker not in second
                assert (
                    "Current Git state:" in second and "Binding revision: 1." in second
                )
                passed(
                    "same conversation switch replaces machine, workspace and project instructions"
                )

                remote_pick = api.remote(
                    "pick", {"machine": "laptop", "workspace": str(remote)}
                )
                catalog = api.remote("catalog", {})
                saved = {item["id"]: item for item in catalog["savedWorkspaces"]}
                assert picked["binding"]["id"] in saved
                target_id = remote_pick["binding"]["id"]
                assert saved[target_id]["workspace"] == str(remote)
                assert saved[target_id]["hostname"] == socket.gethostname()
                assert saved[target_id]["workspaceId"] == remote_pick["workspaceId"]
                assert {"read", "write", "edit", "bash", "grep", "find", "ls"} == set(
                    catalog["tools"]
                )
                passed(
                    "environment picker returns named native workspaces and actual tool capabilities"
                )

                before_probe = get()
                with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                    probes = list(
                        pool.map(
                            lambda _: api.remote("probe", {"target": target_id}),
                            range(3),
                        )
                    )
                assert all(
                    result["status"] == "online" and result["checkedAt"] > 0
                    for result in probes
                )
                assert get()["connection"]["status"] == "online"
                assert get()["revision"] == before_probe["revision"]
                assert get()["control"] == before_probe["control"]
                passed(
                    "parallel live connection checks preserve the workspace and input controller"
                )

                displaced = remote.with_name("workspace-unavailable")
                remote.rename(displaced)
                try:
                    assert (
                        api.remote("probe", {"target": target_id})["status"]
                        == "unavailable"
                    )
                    unavailable = get()
                    assert unavailable["connection"]["status"] == "unavailable"
                    assert unavailable["current"] == before_probe["current"]
                    assert unavailable["revision"] == before_probe["revision"]
                    assert (
                        api.remote("probe", {"target": "cloud"})["status"] == "online"
                    )
                    api.remote("probe", {"target": "not-registered"}, rejected=True)
                    passed(
                        "unavailable workspaces report failure while the cloud stays usable and binding stays fixed"
                    )
                finally:
                    displaced.rename(remote)
                assert api.remote("probe", {"target": target_id})["status"] == "online"
                assert get()["connection"]["status"] == "online"
                assert remote_marker in api.read(session, "AGENTS.md")["text"]
                assert get()["revision"] == before_probe["revision"]
                passed(
                    "connection recovery uses the same target without a model turn or history change"
                )

                refreshed_marker = "REFRESHED-" + run_id
                instructions.write_text(
                    refreshed_marker + "\nKeep {{refreshed-template}} literal.\n"
                )
                third = prompt()
                assert refreshed_marker in third and remote_marker not in third
                assert "{{refreshed-template}}" in third
                passed(
                    "each turn refreshes project instructions and preserves literal template braces"
                )

                switch("cloud", cloud)
                fourth = prompt()
                assert cloud_marker in fourth and refreshed_marker not in fourth
                assert "Machine: cloud" in fourth and "Binding revision: 2." in fourth
                assert (
                    len(
                        [
                            m
                            for m in requests[-1]["messages"]
                            if m["role"] == "assistant"
                        ]
                    )
                    == 3
                )
                passed(
                    "switching back preserves conversation history and uses the latest binding"
                )
                other = api.rpc(
                    "session/create",
                    {"request": {"workspaceId": picked["workspaceId"]}},
                )["sessionId"]
                assert other != session and api.remote("get", {"sessionId": other})[
                    "current"
                ]["workspace"] == str(cloud)
                api.rpc(
                    "workspace/rename",
                    {
                        "request": {
                            "workspaceId": picked["workspaceId"],
                            "title": "My cloud project",
                        }
                    },
                )
                assert (
                    api.remote("pick", {"machine": "cloud", "workspace": str(cloud)})[
                        "title"
                    ]
                    == "My cloud project"
                )
                passed(
                    "new sessions use the chosen workspace and explicit custom names are preserved"
                )

                def workers():
                    found = set()
                    for proc in Path("/proc").iterdir():
                        if not proc.name.isdecimal():
                            continue
                        try:
                            command = (proc / "cmdline").read_bytes().split(b"\0")
                        except OSError:
                            continue
                        if str(remote).encode() in command and any(
                            argument.endswith(b"/worker.mjs") for argument in command
                        ):
                            found.add(int(proc.name))
                    return found

                original_workers = workers()
                slow_pick = api.remote(
                    "pick", {"machine": "slow", "workspace": str(remote)}
                )
                extra_workers = workers() - original_workers
                assert len(extra_workers) == 1
                paused_worker = extra_workers.pop()
                before_timeout = get()
                try:
                    # Pause only this isolated SSH target's real MCP worker;
                    # its already established transport receives the probe.
                    os.kill(paused_worker, signal.SIGSTOP)
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                        start = time.monotonic()
                        delayed = pool.submit(
                            api.remote,
                            "probe",
                            {"target": slow_pick["binding"]["id"]},
                        )
                        assert (
                            api.remote("probe", {"target": "cloud"})["status"]
                            == "online"
                        )
                        result = delayed.result(timeout=18)
                        assert result["status"] == "unavailable"
                        assert "超时" in result["error"]
                        assert 10 <= time.monotonic() - start < 18
                        assert get()["revision"] == before_timeout["revision"]
                        assert get()["current"] == before_timeout["current"]
                finally:
                    if paused_worker in workers():
                        os.kill(paused_worker, signal.SIGCONT)
                assert (
                    api.remote("probe", {"target": slow_pick["binding"]["id"]})[
                        "status"
                    ]
                    == "online"
                )
                passed(
                    "a delayed real SSH probe times out within its bound, preserves other targets and recovers"
                )
                (ROOT / ".local/verification-dsh-context.json").write_text(
                    json.dumps(
                        {
                            "checks": checks,
                            "modelRequests": len(requests),
                            "sessionId": session,
                        },
                        indent=2,
                    )
                    + "\n"
                )
    finally:
        if host:
            host.terminate()
            try:
                host.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(host.pid, signal.SIGKILL)
                host.wait()
        recorder.shutdown()
        recorder.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    run(parser.parse_args())

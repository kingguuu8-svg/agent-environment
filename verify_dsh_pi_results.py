"""Inspect actual Pi results, model requests and durable DSH presentation metadata."""

import argparse
import base64
import concurrent.futures
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from device_onboarding import save
from ssh_fixture import SSHFixture, free_port
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="


def run(args):
    requests, checks, host = [], [], None

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(payload)
            messages = payload["messages"]
            latest = max(
                i
                for i, message in enumerate(messages)
                if message["role"] == "user"
                and any(
                    marker in str(message["content"])
                    for marker in [
                        "SUCCESS-EDIT",
                        "FAIL-EDIT",
                        "IMAGE-READ",
                        "CONCURRENT-",
                        "CANCEL-BASH",
                    ]
                )
            )
            case = str(messages[latest]["content"])
            finished = any(
                message["role"] == "tool" for message in messages[latest + 1 :]
            )
            if finished:
                delta, finish = {"role": "assistant", "content": "PI-RESULT-OK"}, "stop"
            else:
                name, arguments = (
                    "edit",
                    {
                        "path": "说明 空格.txt",
                        "edits": [{"oldText": "BEFORE", "newText": "AFTER"}],
                    },
                )
                if "FAIL-EDIT" in case:
                    arguments["edits"][0]["oldText"] = "does-not-exist"
                elif "IMAGE-READ" in case:
                    name, arguments = "read", {"path": "pixel.png"}
                elif "CANCEL-BASH" in case:
                    name, arguments = (
                        "bash",
                        {
                            "command": 'printf "%s" "$$" > cancel-pid; printf started > cancel-started; sleep 30; printf finished > cancel-finished'
                        },
                    )
                elif "CONCURRENT-" in case:
                    arguments = {
                        "path": "concurrent.txt",
                        "edits": [
                            {
                                "oldText": "BEFORE",
                                "newText": "CLOUD"
                                if "CONCURRENT-CLOUD" in case
                                else "REMOTE",
                            }
                        ],
                    }
                delta = {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "pi-" + uuid.uuid4().hex,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(arguments),
                            },
                        }
                    ],
                }
                finish = "tool_calls"
            body = (
                "".join(
                    "data: "
                    + json.dumps(
                        {
                            "id": "chatcmpl-pi-results",
                            "object": "chat.completion.chunk",
                            "created": 1,
                            "model": "pi-results-fixture",
                            "choices": [
                                {"index": 0, "delta": part, "finish_reason": reason}
                            ],
                        }
                    )
                    + "\n\n"
                    for part, reason in [(delta, None), ({}, finish)]
                )
                + "data: [DONE]\n\n"
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    try:
        with (
            SSHFixture(node=args.node, npm=args.npm) as ssh,
            tempfile.TemporaryDirectory(
                prefix="dsh-pi-results-", dir=ROOT / ".local"
            ) as directory,
        ):
            base = Path(directory)
            cloud, remote, home, state = (
                base / "cloud",
                ssh.target_root / "workspace",
                base / "home",
                base / "state",
            )
            for workspace in [cloud, remote]:
                workspace.mkdir()
                (workspace / "说明 空格.txt").write_text("BEFORE\n")
                (workspace / "concurrent.txt").write_text("BEFORE\n")
                (workspace / "pixel.png").write_bytes(base64.b64decode(PNG))
            save(
                base / "models.json",
                {
                    "providers": {
                        "fixture": {
                            "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                            "api": "openai-completions",
                            "models": [
                                {
                                    "id": "pi-results-fixture",
                                    "reasoning": False,
                                    "input": ["text", "image"],
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
                    str(home),
                    "--state",
                    str(state),
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
            )
            port = free_port()

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

            with (base / "runtime.log").open("a") as log:

                def start():
                    nonlocal host
                    (state / "web-url.json").unlink(missing_ok=True)
                    host = subprocess.Popen(
                        [
                            args.node,
                            str(ROOT / "dsh-host.mjs"),
                            "--home",
                            str(home),
                            "--state",
                            str(state),
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
                            "REMOTE_MCP_CHECK_API_KEY": "pi-results-fixture-key",
                        },
                    )

                    def ready():
                        launch = state / "web-url.json"
                        if not launch.exists():
                            raise RuntimeError("Pi result Host starting")
                        connection = DshApi(json.loads(launch.read_text())["url"])
                        connection.remote("catalog", {})
                        return connection

                    return wait_for(ready, timeout=30)

                try:
                    api = start()
                    sessions, owners = {}, {}
                    for machine, workspace in [("cloud", cloud), ("laptop", remote)]:
                        picked = api.remote(
                            "pick", {"machine": machine, "workspace": str(workspace)}
                        )
                        sid = api.rpc(
                            "session/create",
                            {"request": {"workspaceId": picked["workspaceId"]}},
                        )["sessionId"]
                        sessions[machine], owners[machine] = sid, str(uuid.uuid4())
                        api.remote(
                            "control", {"sessionId": sid, "clientId": owners[machine]}
                        )

                    def prompt(machine, text, wait=True):
                        sid, owner = sessions[machine], owners[machine]
                        control = api.remote(
                            "control", {"sessionId": sid, "clientId": owner}
                        )
                        api.remote(
                            "input",
                            {
                                "clientId": owner,
                                "epoch": control["control"]["epoch"],
                                "method": "prompt",
                                "payload": {
                                    "sessionId": sid,
                                    "requestId": str(uuid.uuid4()),
                                    "mode": "queue",
                                    "content": [{"type": "text", "text": text}],
                                },
                            },
                        )
                        if wait:
                            wait_for(
                                lambda: api.remote("get", {"sessionId": sid}),
                                lambda value: not value["running"],
                                timeout=40,
                            )

                    def events(machine):
                        path = next(
                            (home / "sessions").rglob(
                                sessions[machine] + "/session.v4.jsonl.zstd"
                            )
                        )
                        data = subprocess.check_output(
                            ["zstd", "-dc", str(path)], stderr=subprocess.DEVNULL
                        )
                        return [json.loads(line) for line in data.splitlines()]

                    def results(machine):
                        return [
                            event["data"]
                            for event in events(machine)
                            if event.get("type") == "tool/result"
                        ]

                    prompt("laptop", "SUCCESS-EDIT")
                    edit = wait_for(
                        lambda: results("laptop"),
                        lambda value: bool(value and value[-1].get("meta")),
                    )[-1]
                    assert not edit["message"]["isError"]
                    details = edit["meta"]["remotePi"]
                    assert details["diff"] == "-1 BEFORE\n+1 AFTER"
                    assert "-BEFORE\n+AFTER" in details["patch"]
                    assert details["remote"]["machine"] == "laptop" and details[
                        "remote"
                    ]["workspace"] == str(remote)
                    assert (remote / "说明 空格.txt").read_text() == "AFTER\n"
                    assert (cloud / "说明 空格.txt").read_text() == "BEFORE\n"
                    passed(
                        "a real remote Pi edit persists its exact applied diff, patch and execution identity"
                    )

                    wire = requests[1]
                    tool_messages = [
                        message
                        for message in wire["messages"]
                        if message["role"] == "tool"
                    ]
                    assert (
                        len(tool_messages) == 1
                        and tool_messages[0]["content"]
                        == edit["message"]["content"][0]["text"]
                    )
                    assert "修改差异" not in json.dumps(
                        wire
                    ) and "piPresentation" not in json.dumps(wire)
                    edit_schema = next(
                        tool["function"]["parameters"]
                        for tool in requests[0]["tools"]
                        if tool["function"]["name"] == "edit"
                    )
                    manifest = json.loads((ROOT / "pi-tools.json").read_text())
                    native_schema = next(
                        item["inputSchema"]
                        for item in manifest["tools"]
                        if item["name"] == "edit"
                    )
                    assert edit_schema == native_schema
                    assert "file_path" not in edit_schema["properties"]
                    passed(
                        "model requests keep Pi's original parameters and result text without UI metadata"
                    )

                    prompt("laptop", "FAIL-EDIT")
                    failed = results("laptop")[-1]
                    assert failed["message"]["isError"] and "meta" not in failed
                    assert (remote / "说明 空格.txt").read_text() == "AFTER\n"
                    passed(
                        "a failed Pi edit preserves its file and cannot record an applied diff"
                    )

                    prompt("laptop", "IMAGE-READ")
                    image = results("laptop")[-1]
                    assert not image["message"]["isError"]
                    assert any(
                        part["type"] == "image" for part in image["message"]["content"]
                    ), json.dumps(image, ensure_ascii=False)
                    assert image["meta"]["remotePi"]["remote"]["machine"] == "laptop"
                    assert "data:image/" in json.dumps(requests[-1])
                    passed(
                        "MCP image projection still stores and delivers a real Pi image alongside presentation metadata"
                    )

                    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                        futures = [
                            pool.submit(
                                prompt,
                                machine,
                                "CONCURRENT-"
                                + ("CLOUD" if machine == "cloud" else "REMOTE"),
                            )
                            for machine in ["cloud", "laptop"]
                        ]
                        for future in futures:
                            future.result()
                    concurrent_results = {
                        machine: results(machine)[-1] for machine in ["cloud", "laptop"]
                    }
                    for machine, workspace, marker in [
                        ("cloud", cloud, "CLOUD"),
                        ("laptop", remote, "REMOTE"),
                    ]:
                        item = concurrent_results[machine]
                        assert item["meta"]["remotePi"]["remote"]["machine"] == machine
                        assert (
                            item["meta"]["remotePi"]["diff"]
                            == "-1 BEFORE\n+1 " + marker
                        )
                        assert (
                            workspace / "concurrent.txt"
                        ).read_text() == marker + "\n"
                    passed(
                        "overlapping calls of the same definition keep each machine's actual result metadata"
                    )

                    prompt("laptop", "CANCEL-BASH", wait=False)
                    wait_for(lambda: (remote / "cancel-started").exists(), timeout=20)
                    shell_pid = int((remote / "cancel-pid").read_text())
                    assert Path(f"/proc/{shell_pid}").exists()
                    sid, owner = sessions["laptop"], owners["laptop"]
                    control = api.remote("get", {"sessionId": sid, "clientId": owner})
                    api.remote(
                        "input",
                        {
                            "clientId": owner,
                            "epoch": control["control"]["epoch"],
                            "method": "cancel",
                            "payload": {"sessionId": sid},
                        },
                    )
                    wait_for(
                        lambda: api.remote("get", {"sessionId": sid}),
                        lambda value: not value["running"],
                        timeout=20,
                    )
                    assert not (remote / "cancel-finished").exists()
                    wait_for(lambda: not Path(f"/proc/{shell_pid}").exists(), bool)
                    assert results("laptop")[-1]["message"]["isError"]
                    assert "meta" not in results("laptop")[-1]
                    passed(
                        "actual cancellation stops a remote Pi command without leaving success presentation metadata"
                    )

                    before = {machine: results(machine) for machine in sessions}
                    request_count = len(requests)
                    stop()
                    api = start()
                    for machine, sid in sessions.items():
                        assert api.remote(
                            "get", {"sessionId": sid, "clientId": owners[machine]}
                        )["control"]["mine"]
                        assert results(machine) == before[machine]
                    assert len(requests) == request_count
                    passed(
                        "Host restart restores the original diff and control without replaying any tool or model request"
                    )

                    calls = [
                        event["data"]
                        for event in events("laptop")
                        if event.get("type") == "tool/call"
                    ]
                    save(
                        ROOT / ".local/verification-dsh-pi-results.json",
                        {
                            "checks": checks,
                            "modelRequests": len(requests),
                            "editResult": edit,
                            "failedResult": failed,
                            "toolCalls": calls,
                        },
                    )
                finally:
                    stop()
    finally:
        model.shutdown()
        model.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    run(parser.parse_args())

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
import urllib.error
import urllib.request
import uuid
from email.parser import BytesParser
from email.policy import default as email_policy
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
                        "HISTORY-WRITE",
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
                elif "HISTORY-WRITE" in case:
                    name, arguments = (
                        "write",
                        {"path": "历史 空格.txt", "content": "REMOTE-WRITE\n"},
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

                    prompt("laptop", "HISTORY-WRITE")
                    write = results("laptop")[-1]
                    historical_checks = []

                    def history_passed(name):
                        historical_checks.append(name)
                        passed(name)

                    def origin(machine, call_id, session=None, **options):
                        return api.remote(
                            "toolOrigin",
                            {
                                "sessionId": session or sessions[machine],
                                "callId": call_id,
                            },
                            **options,
                        )

                    def switch(machine, workspace):
                        sid, owner = sessions["laptop"], owners["laptop"]
                        view = api.remote("get", {"sessionId": sid, "clientId": owner})
                        return api.remote(
                            "switch",
                            {
                                "sessionId": sid,
                                "clientId": owner,
                                "epoch": view["control"]["epoch"],
                                "revision": view["revision"],
                                "machine": machine,
                                "workspace": str(workspace),
                            },
                        )

                    def read_bytes(scope_id, path, options=None):
                        endpoint, rpc_id = "workspaceFiles/readBytes", str(uuid.uuid4())
                        request = urllib.request.Request(
                            api.origin + "/api/" + endpoint,
                            data=json.dumps(
                                {
                                    "type": "client-request",
                                    "rpcId": rpc_id,
                                    "method": endpoint,
                                    "payload": {
                                        "args": {
                                            "workspaceFileScopeId": scope_id,
                                            "path": path,
                                            "options": options or {},
                                        }
                                    },
                                }
                            ).encode(),
                            headers={
                                "Content-Type": "application/json",
                                "Origin": api.origin,
                            },
                        )
                        with api.browser.open(request, timeout=30) as response:
                            mime = BytesParser(policy=email_policy).parsebytes(
                                (
                                    "Content-Type: "
                                    + response.headers["Content-Type"]
                                    + "\r\n\r\n"
                                ).encode()
                                + response.read()
                            )
                        fields = {
                            part.get_param(
                                "name", header="content-disposition"
                            ): part.get_payload(decode=True)
                            for part in mime.iter_parts()
                        }
                        metadata = json.loads(fields.pop("metadata"))
                        assert metadata["rpcId"] == rpc_id and metadata["result"]["ok"]
                        (attachment,) = metadata["attachments"]
                        assert attachment["codec"] == "bytes" and attachment[
                            "path"
                        ] == ["data"]
                        value = metadata["result"]["value"]
                        assert value["data"] is None
                        value["data"] = fields.pop(attachment["part"])
                        assert not fields
                        return value

                    edit_id = edit["message"]["toolCallId"]
                    write_id = write["message"]["toolCallId"]
                    image_id = image["message"]["toolCallId"]
                    old_binding = details["origin"]
                    switch("cloud", cloud)
                    scope = origin("laptop", edit_id)["scopeId"]
                    view_before = api.remote(
                        "get",
                        {"sessionId": sessions["laptop"], "clientId": owners["laptop"]},
                    )
                    model_count = len(requests)
                    assert api.read(sessions["laptop"], "说明 空格.txt")[
                        "text"
                    ].splitlines() == ["BEFORE"]
                    assert api.read(scope, "说明 空格.txt")["text"].splitlines() == [
                        "AFTER"
                    ]
                    assert api.read(
                        origin("laptop", write_id)["scopeId"], "历史 空格.txt"
                    )["text"].splitlines() == ["REMOTE-WRITE"]
                    assert origin("laptop", image_id)["binding"] == old_binding
                    stat = api.rpc(
                        "workspaceFiles/stat",
                        {"workspaceFileScopeId": scope, "path": "说明 空格.txt"},
                    )
                    assert stat["absolutePath"] == str(remote / "说明 空格.txt")
                    binary = read_bytes(
                        origin("laptop", image_id)["scopeId"], "pixel.png"
                    )
                    assert binary["absolutePath"] == str(remote / "pixel.png")
                    assert binary["data"] == base64.b64decode(PNG)
                    nested = remote / "nested-history"
                    nested.mkdir()
                    (nested / "inside.txt").write_text("ORIGINAL-LINKED-CONTENT\n")
                    linked = read_bytes(
                        scope,
                        "nested-history/inside.txt",
                        {"baseFile": str(remote / "guide.md")},
                    )
                    assert linked["absolutePath"] == str(nested / "inside.txt")
                    assert linked["data"] == b"ORIGINAL-LINKED-CONTENT\n"
                    assert (
                        api.remote(
                            "get",
                            {
                                "sessionId": sessions["laptop"],
                                "clientId": owners["laptop"],
                            },
                        )
                        == view_before
                    )
                    assert len(requests) == model_count
                    history_passed(
                        "historical read, write and edit scopes retain the original SSH target after handoff, including native stat and image bytes"
                    )

                    outside = ssh.target_root / "outside-history"
                    outside.mkdir()
                    (outside / "secret.txt").write_text("OUTSIDE\n")
                    (remote / "outside-link").symlink_to(
                        outside, target_is_directory=True
                    )
                    for path in [
                        "../outside-history/secret.txt",
                        str(outside / "secret.txt"),
                        "outside-link/secret.txt",
                        str(cloud / "说明 空格.txt"),
                    ]:
                        api.rpc(
                            "workspaceFiles/read",
                            {"workspaceFileScopeId": scope, "path": path, "range": {}},
                            rejected=True,
                        )
                    for call_id in [
                        "missing",
                        failed["message"]["toolCallId"],
                        results("laptop")[-2]["message"]["toolCallId"],
                    ]:
                        origin("laptop", call_id, rejected=True)
                    origin("laptop", edit_id, session="session-missing", rejected=True)
                    for invalid in [
                        "remote-tool-file:{}",
                        "remote-tool-file:bad",
                        "remote-tool-file:[null,0]",
                        'remote-tool-file:["session", "call", "extra"]',
                    ]:
                        api.rpc(
                            "workspaceFiles/read",
                            {
                                "workspaceFileScopeId": invalid,
                                "path": "说明 空格.txt",
                                "range": {},
                            },
                            rejected=True,
                        )
                    unauthorized = urllib.request.Request(
                        api.origin + "/api/remoteWorkspaces/toolOrigin",
                        data=json.dumps(
                            {
                                "type": "client-request",
                                "rpcId": str(uuid.uuid4()),
                                "method": "remoteWorkspaces/toolOrigin",
                                "payload": {
                                    "args": {
                                        "request": {
                                            "sessionId": sessions["laptop"],
                                            "callId": edit_id,
                                        }
                                    }
                                },
                            }
                        ).encode(),
                        headers={
                            "Content-Type": "application/json",
                            "Origin": api.origin,
                        },
                    )
                    try:
                        urllib.request.build_opener(
                            urllib.request.ProxyHandler({})
                        ).open(unauthorized, timeout=10)
                        raise AssertionError(
                            "Historical origin accepted without authentication"
                        )
                    except urllib.error.HTTPError as error:
                        assert error.code in [401, 403]
                    history_passed(
                        "malformed identities, missing or failed calls, non-file calls and paths outside the original workspace are rejected"
                    )

                    second = ssh.target_root / "second-project"
                    second.mkdir()
                    (second / "说明 空格.txt").write_text("SECOND-PROJECT\n")
                    switch("laptop", second)
                    assert api.read(sessions["laptop"], "说明 空格.txt")[
                        "text"
                    ].splitlines() == ["SECOND-PROJECT"]
                    assert api.read(scope, "说明 空格.txt")["text"].splitlines() == [
                        "AFTER"
                    ]
                    fork = api.rpc(
                        "session/fork", {"request": {"sessionId": sessions["laptop"]}}
                    )["sessionId"]
                    fork_scope = origin("laptop", edit_id, session=fork)["scopeId"]
                    assert api.read(fork_scope, "说明 空格.txt")[
                        "text"
                    ].splitlines() == ["AFTER"]
                    assert api.remote("get", {"sessionId": fork})["control"] is None
                    history_passed(
                        "same-machine directory switches and native forks retain each inherited tool's original project without claiming input"
                    )

                    offline = ssh.target_root / "offline-history"
                    remote.rename(offline)
                    try:
                        api.rpc(
                            "workspaceFiles/read",
                            {
                                "workspaceFileScopeId": scope,
                                "path": "说明 空格.txt",
                                "range": {},
                            },
                            rejected=True,
                        )
                        assert api.read(sessions["laptop"], "说明 空格.txt")[
                            "text"
                        ].splitlines() == ["SECOND-PROJECT"]
                    finally:
                        offline.rename(remote)
                    assert api.read(scope, "说明 空格.txt")["text"].splitlines() == [
                        "AFTER"
                    ]
                    history_passed(
                        "an unavailable original workspace fails without using the current target and recovers on the same identity"
                    )

                    stop()
                    api = start()
                    assert origin("laptop", edit_id)["binding"] == old_binding
                    assert api.read(scope, "说明 空格.txt")["text"].splitlines() == [
                        "AFTER"
                    ]
                    history_passed(
                        "cold Host recovery restores historical file origins without replaying model or tools"
                    )

                    # Re-encode only this disposable fixture's actual log to exercise
                    # older releases that persisted fewer presentation fields.
                    stop()
                    log_path = next(
                        (home / "sessions").rglob(
                            sessions["laptop"] + "/session.v4.jsonl.zstd"
                        )
                    )
                    original_log = log_path.read_bytes()
                    legacy_events = events("laptop")

                    def save_legacy():
                        header = (json.dumps(legacy_events[0]) + "\n").encode()
                        data = (
                            "\n".join(json.dumps(event) for event in legacy_events[1:])
                            + "\n"
                        ).encode()
                        log_path.write_bytes(
                            subprocess.check_output(["zstd", "-q", "-c"], input=header)
                            + subprocess.check_output(["zstd", "-q", "-c"], input=data)
                        )

                    for event in legacy_events:
                        if event.get("type") == "tool/result":
                            event["data"].get("meta", {}).get("remotePi", {}).pop(
                                "origin", None
                            )
                    save_legacy()
                    api = start()
                    assert origin("laptop", edit_id)["binding"] == old_binding
                    assert api.read(scope, "说明 空格.txt")["text"].splitlines() == [
                        "AFTER"
                    ]
                    history_passed(
                        "last-release Pi details recover their original target without rewriting old records"
                    )

                    stop()
                    for event in legacy_events:
                        if event.get("type") == "tool/result":
                            event["data"].pop("meta", None)
                    last_switch = next(
                        event
                        for event in reversed(legacy_events)
                        if event.get("type") == "remote/workspace"
                    )
                    api_binding = {
                        "id": "cloud",
                        "machine": "cloud",
                        "workspace": str(cloud),
                    }
                    legacy_events.append(
                        {
                            "type": "remote/workspace",
                            "seq": legacy_events[-1]["seq"] + 1,
                            "time": legacy_events[-1]["time"] + 1,
                            "ignorable": True,
                            "data": {
                                **last_switch["data"],
                                "pending": api_binding,
                                "revision": last_switch["data"]["revision"] + 1,
                            },
                        }
                    )
                    save_legacy()
                    cold_log = log_path.read_bytes()
                    api = start()
                    assert api.read(scope, "说明 空格.txt")["text"].splitlines() == [
                        "AFTER"
                    ]
                    assert log_path.read_bytes() == cold_log
                    # The list can use an older end-seed summary. Activation
                    # must still commit the persisted pending switch, proving
                    # the preceding historical preview did not activate it.
                    activated = api.remote("get", {"sessionId": sessions["laptop"]})
                    assert activated["current"]["id"] == "cloud", activated["current"]
                    assert activated["pending"] is None
                    assert log_path.read_bytes() != cold_log
                    history_passed(
                        "pre-metadata history infers origin at dispatch while cold previews preserve a pending workspace switch"
                    )
                    stop()
                    log_path.write_bytes(original_log)
                    api = start()
                    assert len(requests) == model_count
                    stop()
                    environment_file = state / "environment.json"
                    original_environment = environment_file.read_bytes()
                    altered = json.loads(original_environment)
                    altered[old_binding["id"]]["workspace"] = str(second)
                    save(environment_file, altered)
                    api = start()
                    origin("laptop", edit_id, rejected=True)
                    api.rpc(
                        "workspaceFiles/read",
                        {
                            "workspaceFileScopeId": scope,
                            "path": "说明 空格.txt",
                            "range": {},
                        },
                        rejected=True,
                    )
                    stop()
                    environment_file.write_bytes(original_environment)
                    api = start()
                    assert api.read(scope, "说明 空格.txt")["text"].splitlines() == [
                        "AFTER"
                    ]
                    assert len(requests) == model_count
                    history_passed(
                        "a changed registered target identity is refused, and restoring that identity recovers the same historical scope"
                    )
                    save(
                        ROOT / ".local/verification-dsh-history.json",
                        {
                            "checks": historical_checks,
                            "modelRequestsDuringPreviews": 0,
                            "legacyLogFixture": "presentation metadata removed from disposable actual Pi log",
                            "editResult": edit,
                            "scopeId": scope,
                        },
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

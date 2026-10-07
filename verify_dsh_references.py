"""Verify native file completion on current SSH workspaces and actual model tool reads."""

import argparse
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


def run(args):
    requests = []

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(payload)
            if payload["messages"][-1]["role"] == "tool":
                delta = {"role": "assistant", "content": "REFERENCE-READ-OK"}
                finish = "stop"
            else:
                assert any(
                    tool["function"]["name"] == "read" for tool in payload["tools"]
                )
                delta = {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call-reference-read",
                            "type": "function",
                            "function": {
                                "name": "read",
                                "arguments": json.dumps({"path": "说明 空格.txt"}),
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
                            "id": "chatcmpl-references",
                            "object": "chat.completion.chunk",
                            "created": 1,
                            "model": "references-fixture",
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
    checks = []
    host = None

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    try:
        with (
            SSHFixture(node=args.node, npm=args.npm) as ssh,
            tempfile.TemporaryDirectory(
                prefix="dsh-references-", dir=ROOT / ".local"
            ) as directory,
        ):
            base = Path(directory)
            cloud, remote = base / "cloud A", ssh.target_root / "workspace"
            cloud.mkdir()
            remote.mkdir()
            (cloud / "only-cloud.txt").write_text("CLOUD-ONLY\n")
            (cloud / "说明 空格.txt").write_text("CLOUD-SAME-NAME\n")
            (remote / "说明 空格.txt").write_text("REMOTE-REFERENCE-CONTENT\n")
            (remote / "only-remote.txt").write_text("REMOTE-ONLY\n")
            (remote / ".hidden.txt").write_text("HIDDEN\n")
            nested = remote / "目录 空格"
            nested.mkdir()
            (nested / "nested.txt").write_text("NESTED\n")
            (remote / "node_modules").mkdir()
            (remote / "node_modules/ignored.txt").write_text("DEPENDENCY\n")
            outside = ssh.target_root / "outside"
            outside.mkdir()
            (outside / "secret.txt").write_text("OUTSIDE\n")
            (remote / "link").symlink_to(outside, target_is_directory=True)
            home, state = base / "home", base / "state"
            save(
                base / "models.json",
                {
                    "providers": {
                        "fixture": {
                            "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                            "api": "openai-completions",
                            "models": [
                                {
                                    "id": "references-fixture",
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
            with (base / "runtime.log").open("a") as log:

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
                            "REMOTE_MCP_CHECK_API_KEY": "references-fixture-key",
                        },
                    )

                    def ready():
                        file = state / "web-url.json"
                        if not file.exists():
                            raise RuntimeError("Reference Host starting")
                        api = DshApi(json.loads(file.read_text())["url"])
                        api.remote("catalog", {})
                        return api

                    return wait_for(ready, timeout=30)

                try:
                    api = start()
                    sessions = {}
                    for machine, workspace in [("cloud", cloud), ("laptop", remote)]:
                        picked = api.remote(
                            "pick", {"machine": machine, "workspace": str(workspace)}
                        )
                        sessions[machine] = api.rpc(
                            "session/create",
                            {"request": {"workspaceId": picked["workspaceId"]}},
                        )["sessionId"]

                    def references(machine, query, **options):
                        return api.rpc(
                            "fileReferences/list",
                            {"agentId": sessions[machine], "query": query},
                            **options,
                        )

                    def paths(machine, query):
                        return {item["path"] for item in references(machine, query)}

                    assert paths("cloud", "only") == {"only-cloud.txt"}
                    assert paths("laptop", "only") == {"only-remote.txt"}
                    passed(
                        "native completion resolves the real cloud and SSH workspace separately"
                    )
                    root_paths = paths("laptop", "")
                    assert {
                        "目录 空格",
                        "说明 空格.txt",
                        "only-remote.txt",
                    } <= root_paths
                    assert (
                        ".hidden.txt" not in root_paths
                        and "node_modules" not in root_paths
                    )
                    passed(
                        "root completion keeps native hidden-file and dependency exclusions"
                    )
                    assert paths("laptop", "目录 空格/") == {"目录 空格/nested.txt"}
                    assert paths("laptop", "说明") == {"说明 空格.txt"}
                    assert paths("laptop", ".hidden") == {".hidden.txt"}
                    passed(
                        "directory drilling, Unicode, spaces and explicit hidden-file searches work"
                    )
                    for query in [
                        "../outside/",
                        "link/",
                        "node_modules/",
                        str(outside) + "/",
                        "secret",
                    ]:
                        assert not paths("laptop", query)
                    passed(
                        "traversal, outside paths and symlinks cannot expose other workspace candidates"
                    )
                    references("laptop", "\0", rejected=True)
                    references("laptop", "x" * 4097, rejected=True)
                    api.rpc(
                        "fileReferences/list",
                        {"agentId": "missing-session", "query": ""},
                        rejected=True,
                    )
                    passed(
                        "invalid queries and unknown sessions fail without offering host files"
                    )

                    before = api.remote("get", {"sessionId": sessions["laptop"]})
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                        parallel = list(
                            pool.map(lambda _: paths("laptop", "nested"), range(4))
                        )
                    assert all(value == {"目录 空格/nested.txt"} for value in parallel)
                    assert (
                        api.remote("get", {"sessionId": sessions["laptop"]}) == before
                    )
                    assert before["control"] is None
                    passed(
                        "parallel viewer searches preserve the binding and do not claim input"
                    )

                    displaced = remote.with_name("temporarily-unavailable")
                    remote.rename(displaced)
                    try:
                        references("laptop", "only", rejected=True)
                        assert paths("cloud", "only") == {"only-cloud.txt"}
                    finally:
                        displaced.rename(remote)
                    assert paths("laptop", "only") == {"only-remote.txt"}
                    assert (
                        api.remote("get", {"sessionId": sessions["laptop"]})["current"]
                        == before["current"]
                    )
                    passed(
                        "unavailable targets never fall back to the cloud and recover on the same binding"
                    )

                    sid = sessions["laptop"]
                    client = str(uuid.uuid4())
                    lease = api.remote(
                        "control", {"sessionId": sid, "clientId": client}
                    )

                    def switch(machine, workspace):
                        current = api.remote(
                            "control", {"sessionId": sid, "clientId": client}
                        )
                        return api.remote(
                            "switch",
                            {
                                "sessionId": sid,
                                "clientId": client,
                                "epoch": current["control"]["epoch"],
                                "revision": current["revision"],
                                "machine": machine,
                                "workspace": str(workspace),
                            },
                        )

                    switch("cloud", cloud)
                    assert paths("laptop", "only") == {"only-cloud.txt"}
                    assert paths("cloud", "only") == {"only-cloud.txt"}
                    switch("laptop", remote)
                    assert paths("laptop", "only") == {"only-remote.txt"}
                    passed(
                        "the same conversation follows bidirectional switches while another session stays fixed"
                    )

                    prompt = '@"说明 空格.txt" REFERENCE-WIRE: read this file.'
                    api.remote(
                        "input",
                        {
                            "clientId": client,
                            "epoch": lease["control"]["epoch"],
                            "method": "prompt",
                            "payload": {
                                "sessionId": sid,
                                "requestId": str(uuid.uuid4()),
                                "mode": "queue",
                                "content": [{"type": "text", "text": prompt}],
                            },
                        },
                    )
                    wait_for(lambda: len(requests) >= 2, timeout=30)
                    wait_for(
                        lambda: api.remote("get", {"sessionId": sid}),
                        lambda value: not value["running"],
                        timeout=30,
                    )
                    assert len(requests) == 2
                    assert any(
                        prompt in str(message["content"])
                        for message in requests[0]["messages"]
                        if message["role"] == "user"
                    )
                    system = next(
                        message["content"]
                        for message in requests[0]["messages"]
                        if message["role"] in {"system", "developer"}
                    )
                    assert (
                        "Machine: laptop" in system and f"Workspace: {remote}" in system
                    )
                    assert "Tokens prefixed with @" in system
                    tools = [
                        message
                        for message in requests[1]["messages"]
                        if message["role"] == "tool"
                    ]
                    assert len(tools) == 1 and "REMOTE-REFERENCE-CONTENT" in str(
                        tools[0]["content"]
                    )
                    assert "CLOUD-SAME-NAME" not in str(tools)
                    passed(
                        "an actual model request preserves the quoted reference and Pi reads the target file"
                    )

                    stop()
                    api = start()
                    assert paths("laptop", "only") == {"only-remote.txt"}
                    recovered = api.remote(
                        "get", {"sessionId": sid, "clientId": client}
                    )
                    assert (
                        recovered["control"]["mine"]
                        and recovered["current"]["machine"] == "laptop"
                    )
                    assert len(requests) == 2
                    passed(
                        "Host restart restores reference routing, workspace and original input owner without replay"
                    )
                finally:
                    stop()
        save(
            ROOT / ".local/verification-dsh-references.json",
            {"checks": checks, "passed": True, "modelRequests": len(requests)},
        )
        print(
            json.dumps(
                {"checks": len(checks), "modelRequests": len(requests), "passed": True}
            )
        )
    finally:
        if host and host.poll() is None:
            os.killpg(host.pid, signal.SIGTERM)
            host.wait(timeout=15)
        model.shutdown()
        model.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    run(parser.parse_args())

"""Exercise shared SSH recovery through actual DSH sessions and model tool calls."""

import argparse
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
from ssh_fixture import ROOT, SSHFixture, free_port
from verify_dsh import DshApi, wait_for


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
            if marker == "RECOVERY-OLD":
                name, arguments = (
                    "bash",
                    {
                        "command": "printf 'ONCE\\n' >> old-once.txt; sleep 60; printf 'DONE\\n' > old-finished.txt"
                    },
                )
            elif marker == "RECOVERY-NEW":
                name, arguments = (
                    "bash",
                    {
                        "command": "printf 'STARTED\\n' > new-started.txt; while [ ! -f allow-new-finish ]; do sleep .1; done; printf 'DONE\\n' > new-finished.txt; cat new-finished.txt"
                    },
                )
            elif marker == "RECOVERY-CLOUD":
                name, arguments = (
                    "environment",
                    {
                        "action": "call",
                        "target": "cloud",
                        "tool": "read",
                        "args": {"path": "cloud-proof.txt"},
                    },
                )
            else:
                assert marker == "RECOVERY-READ"
                name, arguments = "read", {"path": "target-proof.txt"}
            delta = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "recovery-" + uuid.uuid4().hex,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments)},
                    }
                ],
            }
            finish = "tool_calls"
        else:
            delta, finish = (
                {"role": "assistant", "content": "DONE:" + marker},
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
                        "id": "chatcmpl-recovery",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "recovery-fixture",
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
    checks = []
    FixtureModel.requests = []
    with (
        SSHFixture(node=args.node, npm=args.npm) as ssh,
        tempfile.TemporaryDirectory(
            prefix="dsh-recovery-", dir=ROOT / ".local"
        ) as directory,
        ThreadingHTTPServer(("127.0.0.1", 0), FixtureModel) as model,
    ):
        base = Path(directory)
        cloud, remote = base / "cloud", ssh.target_root / "接续项目 with spaces"
        cloud.mkdir()
        remote.mkdir()
        (cloud / "cloud-proof.txt").write_text("INDEPENDENT-CLOUD\n")
        (remote / "target-proof.txt").write_text("RECOVERED-REMOTE\n")
        (remote / "AGENTS.md").write_text("SHARED-REMOTE-PROJECT\n")
        threading.Thread(target=model.serve_forever, daemon=True).start()
        save(
            base / "models.json",
            {
                "providers": {
                    "fixture": {
                        "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                        "api": "openai-completions",
                        "models": [
                            {
                                "id": "recovery-fixture",
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
        # This preload exists only in the isolated fixture. It closes a real
        # SDK transport after a real mutation and delays that SDK's rejection.
        hook = base / "hold-native-error.mjs"
        hook.write_text(
            "const { Environment } = await import("
            + json.dumps((ROOT / "environment.mjs").as_uri())
            + ");\nconst directory = "
            + json.dumps(str(base))
            + ";\nconst target = "
            + json.dumps(str(remote))
            + ";\n"
            + r"""
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const connect = Environment.prototype.connect, hooked = new WeakSet();
async function wait(path) {
  for (let i = 0; i < 1200; i++) {
    try { await access(path); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(25);
  }
  throw new Error("Isolated recovery fixture checkpoint timed out");
}
Environment.prototype.connect = async function(id) {
  const connection = await connect.call(this, id);
  if (this.get(id).workspace !== target || hooked.has(connection)) return connection;
  hooked.add(connection);
  const native = connection.client.callTool.bind(connection.client);
  connection.client.callTool = async (...args) => {
    if (args[0].name !== "bash" || !args[0].arguments.command.includes("old-once.txt")) return native(...args);
    const failure = native(args[0], args[1], { ...args[2], timeout: 3000 }).catch((error) => error);
    await wait(join(target, "old-once.txt"));
    await connection.client.close();
    const error = await failure;
    assert.equal(error.code, -32000, "must be the actual SDK closed-transport error");
    await writeFile(join(directory, "old-error.json"), JSON.stringify({ code: error.code }));
    await wait(join(directory, "release-old"));
    throw error;
  };
  return connection;
};
"""
        )
        host = None

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

        with (base / "runtime.log").open("a") as log:
            try:
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
                            "NODE_OPTIONS": "--import=" + hook.as_uri(),
                        },
                    )

                    def ready():
                        launch = base / "state/web-url.json"
                        if not launch.exists():
                            raise RuntimeError("Recovery Host is starting")
                        api = DshApi(json.loads(launch.read_text())["url"])
                        api.remote("catalog", {})
                        return api

                    return wait_for(ready, timeout=30)

                api = start()
                picked = api.remote(
                    "pick", {"machine": "laptop", "workspace": str(remote)}
                )
                sessions, controls = {}, {}
                for device in ["a", "b"]:
                    sessions[device] = api.rpc(
                        "session/create",
                        {"request": {"workspaceId": picked["workspaceId"]}},
                    )["sessionId"]
                    client = str(uuid.uuid4())
                    control = api.remote(
                        "control",
                        {
                            "sessionId": sessions[device],
                            "clientId": client,
                            "label": device + " fixture",
                        },
                    )
                    controls[device] = {
                        "clientId": client,
                        "epoch": control["control"]["epoch"],
                    }

                def view(device):
                    return api.remote(
                        "get",
                        {
                            "sessionId": sessions[device],
                            "clientId": controls[device]["clientId"],
                        },
                    )

                def prompt(device, marker):
                    api.remote(
                        "input",
                        {
                            **controls[device],
                            "method": "prompt",
                            "payload": {
                                "sessionId": sessions[device],
                                "requestId": str(uuid.uuid4()),
                                "mode": "queue",
                                "content": [{"type": "text", "text": marker}],
                            },
                        },
                    )

                originals = {device: view(device) for device in sessions}
                target_id = originals["a"]["current"]["id"]
                prompt("a", "RECOVERY-OLD")
                wait_for(lambda: (base / "old-error.json").exists(), timeout=15)
                assert (
                    json.loads((base / "old-error.json").read_text())["code"] == -32000
                )
                assert view("a")["running"]
                assert (
                    api.remote("probe", {"target": target_id})["status"]
                    == "unavailable"
                )
                assert api.remote("probe", {"target": target_id})["status"] == "online"
                assert api.read(sessions["b"], "target-proof.txt")[
                    "text"
                ].splitlines() == ["RECOVERED-REMOTE"]
                passed(
                    "another DSH session restores the same real SSH workspace while the old tool's SDK error is pending"
                )

                prompt("b", "RECOVERY-NEW")
                wait_for(lambda: (remote / "new-started.txt").exists(), timeout=15)
                (base / "release-old").touch()
                wait_for(
                    lambda: view("a"), lambda value: not value["running"], timeout=15
                )
                assert view("b")["running"], (
                    "old error interrupted the replacement's task"
                )
                assert api.remote("probe", {"target": target_id})["status"] == "online"
                (remote / "allow-new-finish").touch()
                wait_for(
                    lambda: view("b"), lambda value: not value["running"], timeout=15
                )
                assert (remote / "new-finished.txt").read_text() == "DONE\n"
                assert (remote / "old-once.txt").read_text() == "ONCE\n"
                assert not (remote / "old-finished.txt").exists()
                passed(
                    "the old session reports its failed mutation once while the recovered session's native bash completes"
                )

                def request_for(marker, result=False):
                    matching = []
                    for payload in FixtureModel.requests:
                        messages = payload["messages"]
                        last_user = max(
                            i
                            for i, item in enumerate(messages)
                            if item["role"] == "user"
                        )
                        if text(messages[last_user]["content"]) == marker:
                            tools = [
                                item
                                for item in messages[last_user + 1 :]
                                if item["role"] == "tool"
                            ]
                            if not result or tools:
                                matching.append(payload)
                    assert matching
                    return matching[-1]

                old = request_for("RECOVERY-OLD", True)
                assert any(
                    "Connection closed" in text(item["content"])
                    for item in old["messages"]
                    if item["role"] == "tool"
                )
                new = request_for("RECOVERY-NEW", True)
                assert any(
                    "DONE" in text(item["content"])
                    for item in new["messages"]
                    if item["role"] == "tool"
                )
                system = text(new["messages"][0]["content"])
                assert str(remote) in system and "SHARED-REMOTE-PROJECT" in system
                assert "Target connection error" not in system
                for device in sessions:
                    current = view(device)
                    assert current["current"] == originals[device]["current"]
                    assert current["revision"] == originals[device]["revision"]
                    assert current["control"]["mine"]
                    assert (
                        current["control"]["epoch"]
                        == originals[device]["control"]["epoch"]
                    )
                    assert current["pending"] is None
                passed(
                    "actual model requests retain the restored project context and both sessions retain their binding and input ownership"
                )

                prompt("a", "RECOVERY-READ")
                wait_for(
                    lambda: view("a"), lambda value: not value["running"], timeout=15
                )
                assert "RECOVERED-REMOTE" in str(
                    request_for("RECOVERY-READ", True)["messages"]
                )
                prompt("b", "RECOVERY-CLOUD")
                wait_for(
                    lambda: view("b"), lambda value: not value["running"], timeout=15
                )
                assert "INDEPENDENT-CLOUD" in str(
                    request_for("RECOVERY-CLOUD", True)["messages"]
                )
                passed(
                    "the failed session can continue native remote work and the other session can use independent cloud tools"
                )

                def saved_sessions():
                    fields = [
                        "title",
                        "sessionStats",
                        "remoteBinding",
                        "remoteController",
                    ]
                    return {
                        item["sessionId"]: {
                            key: item["projections"]["values"][key] for key in fields
                        }
                        for item in api.rpc("session/list", {"_request": {}})["items"]
                        if item["sessionId"] in sessions.values()
                    }

                count = len(FixtureModel.requests)
                saved = saved_sessions()
                assert len(saved) == 2
                stop()
                api = start()
                for device in sessions:
                    current = view(device)
                    assert current["current"] == originals[device]["current"]
                    assert current["control"]["mine"] and not current["running"]
                    assert api.read(sessions[device], "target-proof.txt")[
                        "text"
                    ].splitlines() == ["RECOVERED-REMOTE"]
                assert saved_sessions() == saved
                assert len(FixtureModel.requests) == count == 8
                passed(
                    "a real Host restart preserves both histories and controllers; read-only recovery sends no additional model requests"
                )
                save(
                    ROOT / ".local/verification-dsh-environment-recovery.json",
                    {
                        "checks": checks,
                        "actualSSH": True,
                        "nativePiTools": True,
                        "modelRequests": count,
                        "productionModelRequests": 0,
                        "mutationExecutions": 1,
                        "source": "real DSH HTTP requests; fixture-only preload delays an actual SDK closed-transport error",
                    },
                )
            finally:
                (base / "release-old").touch()
                (remote / "allow-new-finish").touch()
                stop()
                model.shutdown()
    print(
        "PASS isolated Host, SSH, model recorder and temporary target were cleaned.",
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--npm", required=True)
    run(parser.parse_args())

"""Verify external environment access against isolated DSH and real SSH/Pi tools."""

import argparse
import base64
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import urllib.request
import uuid
from contextlib import ExitStack
from pathlib import Path

from device_onboarding import save
from ssh_fixture import SSHFixture, free_port
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent


def verify(args):
    with (
        tempfile.TemporaryDirectory(prefix="environment-access-") as temporary,
        SSHFixture(node=args.node, npm=args.npm) as ssh,
        ExitStack() as cleanup,
    ):
        base = Path(temporary)
        cloud, home, state = base / "cloud project", base / "home", base / "state"
        cloud.mkdir()
        (cloud / "origin.txt").write_text("CLOUD-ORIGIN\n")
        workspaces = [
            ssh.target_root / name
            for name in ["共享项目 with spaces", "other", "offline"]
        ]
        for path, marker in zip(
            workspaces, ["REMOTE-ORIGIN", "OTHER-ORIGIN", "OFFLINE-ORIGIN"]
        ):
            path.mkdir()
            (path / "origin.txt").write_text(marker + "\n")
        (workspaces[0] / "AGENTS.md").write_text("REMOTE-ACCESS-INSTRUCTIONS\n")
        (workspaces[0] / "tiny.png").write_bytes(
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
            )
        )
        config = json.loads(ssh.config.read_text())
        config["targets"].pop("denied")
        fixture = subprocess.Popen(
            [
                args.node,
                str(ROOT / "mcp_discovery_fixture.mjs"),
                str(base / "mcp.json"),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            cwd=ROOT,
        )
        cleanup.callback(lambda: fixture.communicate('{"action":"quit"}\n', timeout=10))
        assert json.loads(fixture.stdout.readline())["ready"]
        config["mcp"] = {
            "ready_service": json.loads((base / "mcp.json").read_text())["mcp"][
                "ready_service"
            ]
        }
        save(ssh.config, config)
        models = base / "models.json"
        save(
            models,
            {
                "providers": {
                    "fixture": {
                        "baseUrl": "http://127.0.0.1:1/v1",
                        "api": "openai-completions",
                        "models": [
                            {
                                "id": "access-fixture",
                                "contextWindow": 128000,
                                "maxTokens": 1024,
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
                str(models),
            ],
            check=True,
            capture_output=True,
        )
        port, access_port = free_port(), free_port()
        account, key = "fixture-agent", uuid.uuid4().hex
        access = base / "access.json"
        save(
            access,
            {
                "version": 1,
                "url": f"http://127.0.0.1:{access_port}/",
                "port": access_port,
                "account": account,
                "credentialHash": hashlib.sha256(
                    (account + "\0" + key).encode()
                ).hexdigest(),
            },
        )
        host = None
        with (base / "host.log").open("a") as log:

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
                        "REMOTE_ENVIRONMENT_ACCESS_CONFIG": str(access),
                        "REMOTE_MCP_CHECK_API_KEY": "unused-fixture-key",
                    },
                )

                def ready():
                    if not (state / "web-url.json").exists():
                        raise RuntimeError("Host starting")
                    api = DshApi(
                        json.loads((state / "web-url.json").read_text())["url"]
                    )
                    api.remote("catalog", {})
                    return api

                return wait_for(ready, timeout=30)

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
                api = start()
                picked = api.remote(
                    "pick", {"machine": "cloud", "workspace": str(cloud)}
                )
                session = api.rpc(
                    "session/create", {"request": {"cwd": picked["cwd"]}}
                )["sessionId"]
                controller = str(uuid.uuid4())
                view = api.remote(
                    "control",
                    {
                        "sessionId": session,
                        "clientId": controller,
                        "label": "original window",
                    },
                )
                api.remote(
                    "saveDraft",
                    {
                        "sessionId": session,
                        "clientId": controller,
                        "epoch": view["control"]["epoch"],
                        "text": "KEEP-ORIGINAL-DRAFT",
                        "attachmentCount": 0,
                        "revision": 0,
                    },
                )
                before = api.remote(
                    "get", {"sessionId": session, "clientId": controller}
                )
                sessions = api.rpc("session/list", {"_request": {}})
                groups = api.remote("catalog", {})["savedWorkspaces"]
                result = subprocess.run(
                    [args.node, str(ROOT / "verify_environment_access.mjs")],
                    input=json.dumps(
                        {
                            "url": f"http://127.0.0.1:{access_port}/",
                            "account": account,
                            "key": key,
                            "configFile": str(access),
                            "remoteWorkspace": str(workspaces[0]),
                            "otherWorkspace": str(workspaces[1]),
                            "offlineWorkspace": str(workspaces[2]),
                            "cloudWorkspace": str(cloud),
                        }
                    ),
                    text=True,
                    capture_output=True,
                    cwd=ROOT,
                    timeout=180,
                )
                assert result.returncode == 0, result.stdout + result.stderr
                print("\n".join(result.stdout.splitlines()[:-1]), flush=True)
                report = json.loads(result.stdout.splitlines()[-1])
                after = api.remote(
                    "get", {"sessionId": session, "clientId": controller}
                )
                assert before == after, (
                    "External access changed conversation binding, control or draft"
                )
                assert sessions == api.rpc("session/list", {"_request": {}})
                assert groups == api.remote("catalog", {})["savedWorkspaces"]
                registry = json.loads((state / "environment.json").read_text())
                remote_id = next(
                    ident
                    for ident, entry in registry.items()
                    if entry.get("workspace") == str(workspaces[0])
                )
                assert api.remote("probe", {"target": remote_id})["status"] == "online"
                report["checks"].append(
                    "external registrations use the authoritative Host environment while sessions, workspace groups, draft and input owner remain unchanged"
                )
                stop()
                api = start()
                restored = api.remote(
                    "get", {"sessionId": session, "clientId": controller}
                )
                assert restored["current"] == before["current"]
                assert restored["control"]["mine"]
                assert restored["draft"] == before["draft"]
                auth = "Basic " + base64.b64encode(f"{account}:{key}".encode()).decode()
                request = urllib.request.Request(
                    f"http://127.0.0.1:{access_port}/api/environment",
                    data=json.dumps(
                        {
                            "action": "call",
                            "target": remote_id,
                            "tool": "read",
                            "args": {"path": "work.txt"},
                        }
                    ).encode(),
                    headers={"Authorization": auth, "Content-Type": "application/json"},
                )
                response = json.loads(
                    urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    .open(request, timeout=45)
                    .read()
                )
                assert "updated line" in response["result"]["content"][0]["text"]
                report["checks"].append(
                    "Host restart restores external access, registered targets and the original conversation owner/draft"
                )
                save(ROOT / ".local/verification-environment-access.json", report)
                print(
                    f"PASS {len(report['checks'])} external access checks with real SSH/Pi and native Host; zero model requests",
                    flush=True,
                )
            except Exception:
                print((base / "host.log").read_text()[-4000:], file=sys.stderr)
                raise
            finally:
                stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    verify(parser.parse_args())

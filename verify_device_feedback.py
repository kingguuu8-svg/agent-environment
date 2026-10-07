"""Verify authenticated installer progress against an isolated Host and real bridge."""

import argparse
import concurrent.futures
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from device_onboarding import save
from ssh_fixture import free_port
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent


def verify(args, base):
    runtime, state = base / "runtime", base / "state"
    runtime.mkdir()
    cloud, workspace = base / "cloud", base / "device project"
    cloud.mkdir()
    workspace.mkdir()
    (workspace / "AGENTS.md").write_text("DEVICE-FEEDBACK-CONTEXT\n")
    for name in ["device_onboarding.py", "installer_templates.py"]:
        (runtime / name).symlink_to(ROOT / name)
    token, port, pairing = secrets.token_hex(32), free_port(), uuid.uuid4().hex
    save(
        runtime / "dsh-targets.json",
        {
            "targets": {
                "device": {
                    "host": "127.0.0.1",
                    "port": port,
                    "kind": "bridge",
                    "token": token,
                    "node": args.node,
                    "npm": args.npm,
                    "python": sys.executable,
                    "workspace": str(workspace),
                    "label": "Feedback device",
                    "platform": "linux",
                }
            }
        },
    )
    save(
        state / "pairing" / pairing / "receipt.json",
        {
            "expiresAt": int(time.time()) + 900,
            "targetOs": "linux",
            "complete": True,
            "result": {"machine": "device", "cloudPort": port},
            "entryPublicKey": "sensitive-key-must-not-leak",
        },
    )
    save(
        base / "bridge.json",
        {
            "token": token,
            "localPort": port,
            "node": args.node,
            "npm": args.npm,
            "workerRoot": str(base / "worker"),
            "path": str(Path(args.node).parent),
        },
    )
    save(
        base / "models.json",
        {
            "providers": {
                "fixture": {
                    "baseUrl": "http://127.0.0.1:1/v1",
                    "api": "openai-completions",
                    "models": [
                        {
                            "id": "unused-fixture",
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
            str(base / "home"),
            "--state",
            str(state),
            "--workspace",
            str(cloud),
            "--targets",
            str(runtime / "dsh-targets.json"),
            "--python",
            sys.executable,
            "--model",
            str(base / "models.json"),
        ],
        check=True,
    )
    checks = []

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    host = bridge = None
    with (base / "runtime.log").open("w") as log:
        try:
            host = subprocess.Popen(
                [
                    args.node,
                    str(ROOT / "dsh-host.mjs"),
                    "--home",
                    str(base / "home"),
                    "--state",
                    str(state),
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
                    "REMOTE_MCP_CHECK_API_KEY": "unused-fixture-key",
                },
            )

            def login():
                launch = state / "web-url.json"
                if not launch.exists():
                    raise RuntimeError("Feedback Host is starting")
                return DshApi(json.loads(launch.read_text())["url"])

            api = wait_for(login, timeout=30)
            sessions = api.rpc("session/list", {"_request": {}})
            anchors = (
                (state / "anchors.json").read_bytes()
                if (state / "anchors.json").exists()
                else None
            )
            for invalid in [None, 123, [], "../pairing", "A" * 32, "0" * 32]:
                api.remote(
                    "deviceInstallerStatus", {"pairingId": invalid}, rejected=True
                )
            request = urllib.request.Request(
                api.origin + "/api/remoteWorkspaces/deviceInstallerStatus",
                data=json.dumps(
                    {
                        "type": "client-request",
                        "rpcId": str(uuid.uuid4()),
                        "method": "remoteWorkspaces/deviceInstallerStatus",
                        "payload": {"args": {"request": {"pairingId": pairing}}},
                    }
                ).encode(),
                headers={"Content-Type": "application/json", "Origin": api.origin},
            )
            try:
                urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                    request, timeout=5
                )
            except urllib.error.HTTPError as error:
                assert error.code in {401, 403}, error.code
            else:
                raise AssertionError("Anonymous client could inspect pairing progress")
            passed(
                "invalid identities and anonymous installer progress requests are rejected"
            )

            def status():
                return api.remote("deviceInstallerStatus", {"pairingId": pairing})

            started = time.monotonic()
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                pending = list(pool.map(lambda _: status(), range(4)))
            assert time.monotonic() - started < 5
            assert all(
                value["phase"] == "registered"
                and value["connection"]["status"] in {"checking", "unavailable"}
                for value in pending
            )
            unavailable = wait_for(
                status,
                lambda value: value["connection"]["status"] == "unavailable",
                timeout=40,
            )
            assert unavailable["connection"]["error"]
            assert token not in json.dumps(
                unavailable
            ) and "sensitive-key" not in json.dumps(unavailable)
            passed(
                "registered offline devices return truthful bounded feedback to parallel watchers without exposing credentials"
            )

            bridge = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "device_bridge.py"),
                    "--config",
                    str(base / "bridge.json"),
                ],
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
            ready = wait_for(
                status,
                lambda value: value["connection"]["status"] == "online",
                timeout=150,
            )
            assert ready["machine"] == {
                "id": "device",
                "label": "Feedback device",
                "workspace": str(workspace),
            }
            assert ready["connection"]["latencyMs"] >= 0
            listing = api.remote(
                "browse", {"machine": "device", "path": ready["machine"]["workspace"]}
            )
            assert listing["absolutePath"] == str(workspace)
            assert any(item["name"] == "AGENTS.md" for item in listing["entries"])
            passed(
                "automatic retry reaches online through real Pi workspace tools and permits browsing the reported device directory"
            )

            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                repeated = list(pool.map(lambda _: status(), range(4)))
            assert all(value["connection"] == ready["connection"] for value in repeated)
            entries = json.loads((state / "environment.json").read_text())
            assert (
                len(
                    [
                        entry
                        for entry in entries.values()
                        if entry["machine"] == "device"
                        and entry["workspace"] == str(workspace)
                    ]
                )
                == 1
            )
            assert api.rpc("session/list", {"_request": {}}) == sessions
            assert (
                (state / "anchors.json").read_bytes()
                if (state / "anchors.json").exists()
                else None
            ) == anchors
            assert not any(
                item["machine"] == "device"
                for item in api.remote("catalog", {})["savedWorkspaces"]
            )
            passed(
                "parallel readiness checks share their result and preserve session ownership, bindings and native workspace groups"
            )
        finally:
            for process in [host, bridge]:
                if process and process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
    return {
        "checks": checks,
        "environment": "isolated DSH Host and real loopback device bridge",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--npm", required=True)
    args = parser.parse_args()
    (ROOT / ".local").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="device-feedback-", dir=ROOT / ".local"
    ) as directory:
        report = verify(args, Path(directory))
    (ROOT / ".local/verification-device-feedback.json").write_text(
        json.dumps(report, indent=2)
    )
    print(f"Verified {len(report['checks'])} device feedback checks")

"""Verify native new-session recovery after interrupted cross-device entry."""

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from device_onboarding import save
from ssh_fixture import SSHFixture, free_port
from verify_dsh import DshApi, wait_for
from verify_dsh_cloud_drafts import FixtureModel

ROOT = Path(__file__).resolve().parent


def verify(args, base, model_url, ssh):
    cloud, home, state = base / "cloud project", base / "home", base / "state"
    cloud.mkdir()
    remote = ssh.target_root / "workspace"
    remote.mkdir()
    (remote / "fixture-origin.txt").write_text("REMOTE-CREATION-PROOF\n")
    targets = json.loads(ssh.config.read_text())
    targets["targets"].pop("denied")
    save(ssh.config, targets)
    save(
        base / "models.json",
        {
            "providers": {
                "fixture": {
                    "baseUrl": model_url,
                    "api": "openai-completions",
                    "models": [
                        {
                            "id": "ownership-fixture",
                            "reasoning": False,
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
            str(base / "models.json"),
        ],
        check=True,
        capture_output=True,
    )
    port, host = free_port(), None
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
                env={**os.environ, "REMOTE_MCP_CHECK_API_KEY": "unused-fixture-key"},
            )

            def ready():
                launch = state / "web-url.json"
                if not launch.exists():
                    raise RuntimeError("Creation Host is starting")
                api = DshApi(json.loads(launch.read_text())["url"])
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

        def client_checks(api, payload):
            cookies = next(
                handler.cookiejar
                for handler in api.browser.handlers
                if hasattr(handler, "cookiejar")
            )
            result = subprocess.run(
                [args.node, str(ROOT / "verify_dsh_creation.mjs")],
                input=json.dumps(
                    {
                        "origin": api.origin,
                        "cookie": "; ".join(
                            f"{cookie.name}={cookie.value}" for cookie in cookies
                        ),
                        **payload,
                    }
                ),
                text=True,
                capture_output=True,
                timeout=90,
            )
            assert result.returncode == 0, result.stdout + result.stderr
            print("\n".join(result.stdout.splitlines()[:-1]), flush=True)
            return json.loads(result.stdout.splitlines()[-1])

        try:
            api = start()
            picked = api.remote("pick", {"machine": "cloud", "workspace": str(cloud)})
            other = api.remote("pick", {"machine": "laptop", "workspace": str(remote)})
            payload = {
                "workspaceId": picked["workspaceId"],
                "otherWorkspaceId": other["workspaceId"],
                "baseline": args.baseline,
            }
            if args.client_ref:
                payload["clientSource"] = subprocess.run(
                    ["git", "show", args.client_ref + ":dsh-product/plugin/client.js"],
                    cwd=ROOT,
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout
            report = client_checks(api, payload)
            if not args.baseline:
                stop()
                api = start()
                cold = client_checks(api, {"recovery": report.pop("restartRecovery")})
                report["checks"] += cold["checks"]
                report["hostRestarts"] = 1
            assert not FixtureModel.requests
            return {**report, "modelRequests": 0}
        finally:
            stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--npm", required=True)
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument(
        "--client-ref", help="Git client revision for a baseline control"
    )
    args = parser.parse_args()
    (ROOT / ".local").mkdir(exist_ok=True)
    with (
        SSHFixture(node=args.node, npm=args.npm) as ssh,
        tempfile.TemporaryDirectory(
            prefix="dsh-creation-", dir=ROOT / ".local"
        ) as directory,
    ):
        with ThreadingHTTPServer(("127.0.0.1", 0), FixtureModel) as model:
            threading.Thread(target=model.serve_forever, daemon=True).start()
            try:
                report = verify(
                    args,
                    Path(directory),
                    f"http://127.0.0.1:{model.server_port}/v1",
                    ssh,
                )
            finally:
                model.shutdown()
    suffix = "before" if args.baseline else "verified"
    (ROOT / f".local/verification-dsh-creation-{suffix}.json").write_text(
        json.dumps(report, indent=2)
    )
    print(json.dumps(report), flush=True)

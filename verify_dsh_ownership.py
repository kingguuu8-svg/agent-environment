"""Verify durable window ownership, fresh epochs and independent native DSH branches."""

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
from ssh_fixture import free_port
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent


class FixtureModel(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *arguments):
        pass

    def do_POST(self):
        self.requests.append(
            json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        )
        chunks = [
            {
                "delta": {"role": "assistant", "content": "OWNERSHIP-OK"},
                "finish_reason": None,
            },
            {"delta": {}, "finish_reason": "stop"},
        ]
        body = (
            "".join(
                "data: "
                + json.dumps(
                    {
                        "id": "chatcmpl-ownership",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "ownership-fixture",
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


def verify(args, base, model_url):
    cloud, home, state = base / "cloud project", base / "home", base / "state"
    cloud.mkdir()
    save(base / "targets.json", {"targets": {}})
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
            str(base / "targets.json"),
            "--python",
            sys.executable,
            "--model",
            str(base / "models.json"),
        ],
        check=True,
    )
    port, host, checks = free_port(), None, []

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

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
                file = state / "web-url.json"
                if not file.exists():
                    raise RuntimeError("Ownership Host is starting")
                api = DshApi(json.loads(file.read_text())["url"])
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
            picked = api.remote("pick", {"machine": "cloud", "workspace": str(cloud)})
            session = api.rpc(
                "session/create", {"request": {"workspaceId": picked["workspaceId"]}}
            )["sessionId"]
            owner, viewer = str(uuid.uuid4()), str(uuid.uuid4())

            def control(client, target=session, takeover=False):
                return api.remote(
                    "control",
                    {
                        "sessionId": target,
                        "clientId": client,
                        "label": "Original window"
                        if client == owner
                        else "Viewer window",
                        "takeover": takeover,
                    },
                )

            def get(client, target=session):
                return api.remote("get", {"sessionId": target, "clientId": client})

            def rename(client, epoch, title, rejected=False):
                return api.remote(
                    "input",
                    {
                        "clientId": client,
                        "epoch": epoch,
                        "method": "rename",
                        "payload": {"sessionId": session, "title": title},
                    },
                    rejected=rejected,
                )

            initial = control(owner)
            assert initial["control"]["mine"] and not control(viewer)["control"]["mine"]
            initial_epoch = initial["control"]["epoch"]
            passed(
                "a new native session has one explicit input controller and viewers stay read-only"
            )

            # Native forks require a completed turn. Use the real agent loop
            # against a local SSE fixture, without spending on a model provider.
            api.remote(
                "input",
                {
                    "clientId": owner,
                    "epoch": initial_epoch,
                    "method": "prompt",
                    "payload": {
                        "sessionId": session,
                        "requestId": str(uuid.uuid4()),
                        "mode": "queue",
                        "content": [{"type": "text", "text": "Reply OWNERSHIP-OK."}],
                    },
                },
            )
            wait_for(lambda: FixtureModel.requests, timeout=30)
            wait_for(lambda: get(owner), lambda value: not value["running"], timeout=30)
            assert len(FixtureModel.requests) == 1
            fork = api.rpc("session/fork", {"request": {"sessionId": session}})[
                "sessionId"
            ]
            untouched = api.rpc("session/fork", {"request": {"sessionId": session}})[
                "sessionId"
            ]
            assert get(owner, fork)["control"] is None
            assert get(viewer, untouched)["control"] is None
            assert get(owner, fork)["current"] == get(owner)["current"]
            assert control(viewer, fork)["control"]["mine"]
            assert get(owner)["control"]["mine"]
            passed(
                "native forks inherit the workspace and history while acquiring independent input ownership"
            )

            takeover = control(viewer, takeover=True)
            assert takeover["control"]["mine"] and not get(owner)["control"]["mine"]
            rename(owner, initial_epoch, "MUST NOT RENAME", rejected=True)
            before_restart = control(owner, takeover=True)
            passed(
                "only an explicit takeover transfers input and the previous controller cannot mutate the session"
            )

            stop()
            api = start()
            first_viewer = control(viewer)
            assert not first_viewer["control"]["mine"]
            assert first_viewer["control"]["label"] == "Original window"
            restored = control(owner)
            assert restored["control"]["mine"]
            assert restored["control"]["epoch"] != before_restart["control"]["epoch"]
            assert restored["current"] == before_restart["current"]
            passed(
                "the first viewer after a real Host restart cannot claim the persisted controller or change its workspace"
            )

            rename(
                owner, before_restart["control"]["epoch"], "STALE EPOCH", rejected=True
            )
            rename(viewer, restored["control"]["epoch"], "WRONG WINDOW", rejected=True)
            renamed = rename(owner, restored["control"]["epoch"], "Ownership recovered")
            assert renamed["title"] == "Ownership recovered"
            item = next(
                item
                for item in api.rpc("session/list", {"_request": {}})["items"]
                if item["sessionId"] == session
            )
            assert item["projections"]["values"]["title"] == "Ownership recovered"
            api.rpc(
                "session/rename",
                {"request": {"sessionId": session, "title": "BYPASS"}},
                rejected=True,
            )
            passed(
                "stale epochs, foreign windows and native guard bypasses cannot rename; the refreshed original controller can"
            )

            assert control(owner, fork)["control"]["mine"] is False
            assert control(viewer, fork)["control"]["mine"]
            assert get(owner, untouched)["control"] is None
            assert control(viewer, untouched)["control"]["mine"]
            passed(
                "restored branches preserve their own controllers and an unclaimed branch stays unowned across restart"
            )

            taken = control(viewer, takeover=True)
            stop()
            api = start()
            assert control(owner)["control"]["mine"] is False
            current = control(viewer)
            assert (
                current["control"]["mine"]
                and current["control"]["epoch"] != taken["control"]["epoch"]
            )
            assert (
                next(
                    item
                    for item in api.rpc("session/list", {"_request": {}})["items"]
                    if item["sessionId"] == session
                )["projections"]["values"]["title"]
                == "Ownership recovered"
            )
            passed(
                "an explicit handoff survives a second cold start even when the old owner requests control first"
            )
        finally:
            stop()
    return {
        "checks": checks,
        "environment": "isolated native DSH Host, real cloud Pi workspace and two cold restarts",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    (ROOT / ".local").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="dsh-ownership-", dir=ROOT / ".local"
    ) as directory:
        with ThreadingHTTPServer(("127.0.0.1", 0), FixtureModel) as model:
            threading.Thread(target=model.serve_forever, daemon=True).start()
            try:
                report = verify(
                    args, Path(directory), f"http://127.0.0.1:{model.server_port}/v1"
                )
            finally:
                model.shutdown()
    (ROOT / ".local/verification-dsh-ownership.json").write_text(
        json.dumps(report, indent=2)
    )
    print(f"Verified {len(report['checks'])} input ownership checks")

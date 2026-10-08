"""Verify cloud draft ownership, cross-device handoff, submission and restart recovery."""

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
    other = base / "other project"
    other.mkdir()
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
            sid = api.rpc(
                "session/create", {"request": {"workspaceId": picked["workspaceId"]}}
            )["sessionId"]
            owner, viewer = str(uuid.uuid4()), str(uuid.uuid4())
            view = api.remote(
                "control", {"sessionId": sid, "clientId": owner, "label": "Device A"}
            )
            fields = [
                "title",
                "sessionStats",
                "remoteBinding",
                "remoteController",
                "agentPreset",
            ]

            def snapshot():
                item = next(
                    item
                    for item in api.rpc("session/list", {"_request": {}})["items"]
                    if item["sessionId"] == sid
                )
                return {key: item["projections"]["values"][key] for key in fields}

            before = snapshot()
            assert view["draft"] == {
                "text": "",
                "attachmentCount": 0,
                "revision": 0,
                "clientId": None,
            }
            text = "MULTI-DEVICE-DRAFT\n继续这个项目。"

            def save_draft(client, epoch, revision, text=text, count=0, rejected=False):
                return api.remote(
                    "saveDraft",
                    {
                        "sessionId": sid,
                        "clientId": client,
                        "epoch": epoch,
                        "revision": revision,
                        "text": text,
                        "attachmentCount": count,
                    },
                    rejected=rejected,
                )

            saved = save_draft(owner, view["control"]["epoch"], 0)
            assert (
                saved["accepted"]
                and saved["draft"]["text"] == text
                and saved["draft"]["revision"] == 1
            )
            assert snapshot() == before and not FixtureModel.requests
            passed(
                "draft persists in cloud without entering history, changing the workspace, input owner or sending a model request"
            )
            assert save_draft(owner, view["control"]["epoch"], 0) == saved
            assert not save_draft(owner, view["control"]["epoch"], 0, text="STALE")[
                "accepted"
            ]
            assert (
                api.remote("get", {"sessionId": sid, "clientId": viewer})["draft"]
                == saved["draft"]
            )
            save_draft(
                viewer, view["control"]["epoch"], 1, text="UNAUTHORIZED", rejected=True
            )
            passed(
                "retries are idempotent, stale revisions cannot overwrite newer text and viewers cannot write cloud drafts"
            )
            new = api.remote(
                "control",
                {
                    "sessionId": sid,
                    "clientId": viewer,
                    "takeover": True,
                    "label": "Device B",
                },
            )
            assert new["draft"] == saved["draft"]
            save_draft(
                owner, view["control"]["epoch"], 1, text="LATE-DEVICE-A", rejected=True
            )
            revised = save_draft(
                viewer, new["control"]["epoch"], 1, text="DEVICE-B-NEW"
            )
            assert revised["draft"]["revision"] == 2
            passed(
                "explicit device handoff carries the cloud draft and fences old device autosaves"
            )
            for invalid in [
                {"text": None},
                {"text": "x" * 262145},
                {"revision": -1},
                {"attachmentCount": -1},
                {"attachmentCount": 1001},
            ]:
                request = {
                    "sessionId": sid,
                    "clientId": viewer,
                    "epoch": new["control"]["epoch"],
                    "revision": 2,
                    "text": "INVALID",
                    "attachmentCount": 0,
                    **invalid,
                }
                api.remote("saveDraft", request, rejected=True)
            assert api.remote("get", {"sessionId": sid})["draft"] == revised["draft"]
            passed(
                "invalid text, excessive content, negative revisions and invalid attachment counts leave the saved draft intact"
            )
            saved_state = snapshot()
            stop()
            api = start()
            restored = api.remote("get", {"sessionId": sid, "clientId": viewer})
            assert (
                restored["control"]["mine"]
                and restored["draft"] == revised["draft"]
                and snapshot() == saved_state
            )
            save_draft(
                viewer, new["control"]["epoch"], 2, text="STALE-EPOCH", rejected=True
            )
            passed(
                "real Host restart preserves the draft and controller while fencing pre-restart credentials"
            )
            epoch = restored["control"]["epoch"]
            prompt = {
                "sessionId": sid,
                "requestId": str(uuid.uuid4()),
                "mode": "queue",
                "content": [{"type": "text", "text": "EXPLICIT-SEND"}],
            }
            admission = api.remote(
                "input",
                {
                    "clientId": viewer,
                    "epoch": epoch,
                    "method": "prompt",
                    "payload": prompt,
                    "draftAck": True,
                },
            )
            wait_for(
                lambda: api.remote("get", {"sessionId": sid}),
                lambda value: not value["running"],
                timeout=15,
            )
            cleared = api.remote("get", {"sessionId": sid})["draft"]
            assert cleared["text"] == "" and cleared["revision"] == 3
            assert admission == {"result": {"accepted": True}, "draft": cleared}
            assert not save_draft(viewer, epoch, 2, text="LATE-PRE-SEND")["accepted"]
            assert len(FixtureModel.requests) == 1 and "DEVICE-B-NEW" not in str(
                FixtureModel.requests
            )
            passed(
                "an explicitly accepted message clears the cloud draft, rejects delayed pre-send saves and sends no unsent draft to the model"
            )
            updated = save_draft(viewer, epoch, 3, text="NEXT-MESSAGE")
            fork = api.rpc("session/fork", {"request": {"sessionId": sid}})["sessionId"]
            assert api.remote("get", {"sessionId": fork})["draft"]["text"] == ""
            assert api.remote("get", {"sessionId": sid})["draft"] == updated["draft"]
            passed(
                "native branches have independent cloud drafts and opening one cannot alter the original"
            )
            api.remote(
                "input",
                {
                    "clientId": viewer,
                    "epoch": epoch,
                    "method": "prompt",
                    "payload": prompt,
                },
            )
            assert (
                api.remote("get", {"sessionId": sid})["draft"] == updated["draft"]
                and len(FixtureModel.requests) == 1
            )
            stop()
            api = start()
            epoch = api.remote("get", {"sessionId": sid, "clientId": viewer})[
                "control"
            ]["epoch"]
            api.remote(
                "input",
                {
                    "clientId": viewer,
                    "epoch": epoch,
                    "method": "prompt",
                    "payload": prompt,
                },
            )
            assert (
                api.remote("get", {"sessionId": sid})["draft"] == updated["draft"]
                and len(FixtureModel.requests) == 1
            )
            passed(
                "replaying a previously accepted request before and after restart preserves the next message draft without replaying a turn"
            )
            api.remote(
                "input",
                {
                    "clientId": viewer,
                    "epoch": epoch,
                    "method": "prompt",
                    "payload": {
                        **prompt,
                        "requestId": str(uuid.uuid4()),
                        "content": [],
                    },
                },
                rejected=True,
            )
            assert api.remote("get", {"sessionId": sid})["draft"] == updated["draft"]
            passed("rejected message admission preserves the existing cloud draft")
            files = list((state / "drafts").glob("*.json"))
            assert files and all(file.stat().st_mode & 0o777 == 0o600 for file in files)
            assert (state / "drafts").stat().st_mode & 0o777 == 0o700
            assert len(FixtureModel.requests) == 1
            passed(
                "cloud drafts use private atomic files, independent session identities and no extra model requests"
            )
            choice_sid = api.rpc(
                "session/create", {"request": {"workspaceId": picked["workspaceId"]}}
            )["sessionId"]
            choice_owner, choice_viewer = str(uuid.uuid4()), str(uuid.uuid4())
            choice_view = api.remote(
                "control", {"sessionId": choice_sid, "clientId": choice_owner}
            )
            choice_saved = api.remote(
                "saveDraft",
                {
                    "sessionId": choice_sid,
                    "clientId": choice_owner,
                    "epoch": choice_view["control"]["epoch"],
                    "revision": 0,
                    "text": "CLOUD-CHOICE\n保留中文文字。",
                    "attachmentCount": 2,
                },
            )["draft"]
            choice_request = {
                "sessionId": choice_sid,
                "clientId": choice_viewer,
                "revision": choice_saved["revision"],
                "text": choice_saved["text"],
                "takeover": True,
            }
            choice_before = api.remote(
                "get", {"sessionId": choice_sid, "clientId": choice_owner}
            )
            api.remote(
                "selectDraft", {**choice_request, "takeover": False}, rejected=True
            )
            for invalid in [
                {"text": None},
                {"text": "界" * 90000},
                {"revision": -1},
                {"revision": 1.1},
                {"clientId": "invalid"},
            ]:
                api.remote("selectDraft", {**choice_request, **invalid}, rejected=True)
            assert (
                api.remote("get", {"sessionId": choice_sid, "clientId": choice_owner})
                == choice_before
            )
            passed(
                "draft selection rejects unauthorized viewers, invalid identities, noninteger revisions and excessive UTF-8 text without side effects"
            )
            api.remote("selectDraft", {**choice_request, "revision": 0}, rejected=True)
            assert (
                api.remote("get", {"sessionId": choice_sid, "clientId": choice_owner})
                == choice_before
            )
            passed(
                "a stale draft confirmation cannot take control from its source device"
            )
            choice_selected = api.remote("selectDraft", choice_request)
            assert choice_selected["control"]["mine"]
            assert choice_selected["draft"] == {
                **choice_saved,
                "revision": choice_saved["revision"] + 1,
                "attachmentCount": 0,
                "clientId": choice_viewer,
            }
            assert all(
                choice_selected[key] == choice_before[key]
                for key in ["current", "pending", "revision", "running"]
            )
            passed(
                "explicit text-only selection claims input and advances the draft while preserving the execution workspace and task state"
            )
            choice_epoch = choice_selected["control"]["epoch"]
            fenced = api.remote(
                "selectDraft",
                {
                    **choice_request,
                    "takeover": False,
                    "epoch": choice_epoch,
                    "revision": choice_selected["draft"]["revision"],
                },
            )
            assert fenced["control"]["epoch"] == choice_epoch
            assert (
                fenced["draft"]["revision"] == choice_selected["draft"]["revision"] + 1
            )
            assert not api.remote(
                "saveDraft",
                {
                    "sessionId": choice_sid,
                    "clientId": choice_viewer,
                    "epoch": choice_epoch,
                    "revision": choice_selected["draft"]["revision"],
                    "text": "LATE-SAME-DEVICE",
                    "attachmentCount": 0,
                },
            )["accepted"]
            passed(
                "same-controller draft selection fences late autosaves even when the chosen text is unchanged"
            )
            stop()
            api = start()
            choice_restored = api.remote(
                "get", {"sessionId": choice_sid, "clientId": choice_viewer}
            )
            assert choice_restored["draft"] == fenced["draft"]
            assert choice_restored["control"]["mine"]
            assert choice_restored["current"] == fenced["current"]
            assert len(FixtureModel.requests) == 1
            passed(
                "Host restart preserves the selected draft and input owner without adding a model turn"
            )
            cookies = next(
                handler.cookiejar
                for handler in api.browser.handlers
                if hasattr(handler, "cookiejar")
            )
            client_checks = subprocess.run(
                [args.node, str(ROOT / "verify_dsh_cloud_drafts.mjs")],
                input=json.dumps(
                    {
                        "origin": api.origin,
                        "cookie": "; ".join(
                            f"{cookie.name}={cookie.value}" for cookie in cookies
                        ),
                        "workspaceId": picked["workspaceId"],
                    }
                ),
                text=True,
                capture_output=True,
                timeout=90,
            )
            assert client_checks.returncode == 0, (
                client_checks.stdout + client_checks.stderr
            )
            print(client_checks.stdout, end="", flush=True)
            client_report = json.loads(client_checks.stdout.splitlines()[-1])
            assert client_report["checks"] == 26
            wait_for(
                lambda: api.rpc("session/list", {"_request": {}})["items"],
                lambda items: all(
                    not api.remote("get", {"sessionId": item["sessionId"]})["running"]
                    for item in items
                ),
                timeout=15,
            )
            assert 2 <= len(FixtureModel.requests) <= 5
            assert "带附件的说明" not in str(FixtureModel.requests)
            assert "断网继续写" not in str(FixtureModel.requests)
            return {
                "checks": checks,
                "clientChecks": client_report["checks"],
                "explicitPrompts": 1 + client_report["explicitPrompts"],
                "modelRequests": len(FixtureModel.requests),
                "scope": "isolated native DSH Host, no production changes",
            }

        finally:
            stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    (ROOT / ".local").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="dsh-cloud-drafts-", dir=ROOT / ".local"
    ) as directory:
        with ThreadingHTTPServer(("127.0.0.1", 0), FixtureModel) as model:
            threading.Thread(target=model.serve_forever, daemon=True).start()
            try:
                report = verify(
                    args, Path(directory), f"http://127.0.0.1:{model.server_port}/v1"
                )
            finally:
                model.shutdown()
    (ROOT / ".local/verification-dsh-cloud-drafts.json").write_text(
        json.dumps(report, indent=2)
    )
    print(f"Verified {len(report['checks'])} cloud draft checks")

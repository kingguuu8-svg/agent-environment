"""Exercise native DSH sessions, remote bindings, files, leases and real model effects."""

import argparse
import http.cookiejar
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


class DshApi:
    def __init__(self, launch_url, origin=None):
        parsed = urllib.parse.urlsplit(launch_url)
        self.origin = origin or f"{parsed.scheme}://{parsed.netloc}"
        self.browser = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )
        self.browser.open(self.origin + "/?" + parsed.query, timeout=10).read()

    def rpc(self, endpoint, args, *, rejected=False):
        envelope = {
            "type": "client-request",
            "rpcId": str(uuid.uuid4()),
            "method": endpoint,
            "payload": {"args": args},
        }
        request = urllib.request.Request(
            self.origin + "/api/" + endpoint,
            data=json.dumps(envelope).encode(),
            headers={"Content-Type": "application/json", "Origin": self.origin},
        )
        result = json.loads(self.browser.open(request, timeout=180).read())["result"]
        if rejected:
            assert not result["ok"], result
            return result["error"]
        if not result["ok"]:
            raise RuntimeError(f"{endpoint}: {result['error']}")
        return result["value"]

    def remote(self, method, request, **options):
        return self.rpc("remoteWorkspaces/" + method, {"request": request}, **options)

    def read(self, session, path):
        return self.rpc(
            "workspaceFiles/read",
            {"workspaceFileScopeId": session, "path": path, "range": {}},
        )


def wait_for(operation, predicate=lambda value: bool(value), timeout=180):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = operation()
            if predicate(last):
                return last
        except (RuntimeError, urllib.error.URLError) as error:
            last = str(error)
        time.sleep(0.5)
    raise AssertionError(f"Timed out: {last}")


def run(args):
    api = wait_for(
        lambda: DshApi(json.loads(args.url_file.read_text())["url"], args.origin),
        timeout=20,
    )
    checks = []

    def passed(name):
        checks.append(name)
        print(f"PASS {name}", flush=True)

    catalog = api.remote("catalog", {})
    assert {"cloud", args.machine} <= {item["id"] for item in catalog["machines"]}
    passed("machine catalog")
    cloud = next(
        item["workspace"] for item in catalog["machines"] if item["id"] == "cloud"
    )
    listing = api.remote("browse", {"machine": args.machine, "path": args.workspace})
    assert listing["absolutePath"] == args.workspace
    # Open this workspace before the timed turn; first SSH/bootstrap latency
    # must not consume the window used to exercise a pending switch.
    api.remote("pick", {"machine": args.machine, "workspace": args.workspace})
    passed("remote directory picker")
    picked = api.remote("pick", {"machine": "cloud", "workspace": cloud})
    created = api.rpc("session/create", {"request": {"cwd": picked["cwd"]}})
    session = created["sessionId"]
    controller = str(uuid.uuid4())
    controlled = api.remote(
        "control",
        {"sessionId": session, "clientId": controller, "label": "DSH verification"},
    )
    assert controlled["current"]["machine"] == "cloud"
    epoch = controlled["control"]["epoch"]
    passed("native session creation and binding")

    def get():
        return api.remote("get", {"sessionId": session, "clientId": controller})

    def input_request(text, request_id=None):
        return {
            "requestId": request_id or str(uuid.uuid4()),
            "sessionId": session,
            "mode": "queue",
            "content": [{"type": "text", "text": text}],
        }

    def prompt(text, request_id=None):
        return api.remote(
            "input",
            {
                "clientId": controller,
                "epoch": epoch,
                "method": "prompt",
                "payload": input_request(text, request_id),
            },
        )

    api.rpc(
        "session/prompt", {"request": input_request("Do not run this.")}, rejected=True
    )
    passed("native prompt cannot bypass controller")
    viewer = str(uuid.uuid4())
    observed = api.remote(
        "control", {"sessionId": session, "clientId": viewer, "label": "Viewer"}
    )
    assert observed["control"]["mine"] is False
    api.remote(
        "input",
        {
            "clientId": viewer,
            "epoch": epoch,
            "method": "prompt",
            "payload": input_request("Do not run this."),
        },
        rejected=True,
    )
    passed("shared conversation has one input controller")

    run_id = "dsh-" + uuid.uuid4().hex[:12]
    started, finished, remote_file, queued_file = (
        f"{run_id}-{suffix}.txt"
        for suffix in ("started", "finished", "remote", "queued")
    )
    prompt(
        f"Use bash to execute exactly this command in the current workspace: printf 'STARTED\\n' > {started}; sleep 20; printf 'FINISHED\\n' > {finished}. Then reply with the machine and workspace. Do not use any other target."
    )
    wait_for(
        lambda: api.read(session, started), lambda value: "STARTED" in value["text"]
    )
    assert get()["running"]
    pending = api.remote(
        "switch",
        {
            "sessionId": session,
            "clientId": controller,
            "epoch": epoch,
            "revision": get()["revision"],
            "machine": args.machine,
            "workspace": args.workspace,
        },
    )
    assert pending["current"]["machine"] == "cloud"
    assert pending["pending"]["machine"] == args.machine
    passed("running turn retains its execution target")
    api.remote(
        "switch",
        {
            "sessionId": session,
            "clientId": controller,
            "epoch": epoch,
            "revision": pending["revision"] - 1,
            "machine": "cloud",
            "workspace": cloud,
        },
        rejected=True,
    )
    assert get()["pending"] == pending["pending"]
    passed("stale switch revision cannot replace a pending choice")
    discarded = api.remote(
        "discardSwitch", {"sessionId": session, "clientId": controller, "epoch": epoch}
    )
    assert discarded["pending"] is None and discarded["current"]["machine"] == "cloud"
    passed("pending switch can be revoked while the turn is running")
    api.remote(
        "switch",
        {
            "sessionId": session,
            "clientId": controller,
            "epoch": epoch,
            "revision": discarded["revision"],
            "machine": args.machine,
            "workspace": args.workspace,
        },
    )
    followup_id = str(uuid.uuid4())
    followup = f"This queued request must execute AFTER the pending workspace switch. Use bash once to run exactly: printf 'QUEUED-ON-REMOTE\\n' >> {queued_file}. Use the current workspace only and reply with its machine and directory."
    prompt(followup, followup_id)
    prompt(followup, followup_id)
    settled = wait_for(get, lambda value: value["current"]["machine"] == args.machine)
    assert settled["pending"] is None
    passed("queued workspace switch commits after the turn")
    wait_for(
        lambda: api.read(session, queued_file),
        lambda value: "QUEUED-ON-REMOTE" in value["text"],
    )
    wait_for(get, lambda value: not value["running"])
    assert api.read(session, queued_file)["text"].splitlines() == ["QUEUED-ON-REMOTE"]
    passed("already queued prompt uses new binding and duplicate request executes once")
    state_file = args.state_file or args.url_file.parent / "verification-session.json"
    state_file.write_text(
        json.dumps(
            {
                "sessionId": session,
                "machine": args.machine,
                "workspace": args.workspace,
                "runId": run_id,
            }
        )
    )
    state_file.chmod(0o600)

    before = get()
    api.remote(
        "switch",
        {
            "sessionId": session,
            "clientId": controller,
            "epoch": epoch,
            "revision": before["revision"],
            "machine": args.machine,
            "workspace": args.workspace + "/does-not-exist-" + run_id,
        },
        rejected=True,
    )
    assert get()["current"] == before["current"]
    passed("invalid workspace leaves binding unchanged")
    prompt(
        f"We switched execution targets. Use write to create {remote_file} in the CURRENT workspace with exactly 'REMOTE-VERIFIED\\n'. Then use read to verify it and state the current machine and directory."
    )
    wait_for(
        lambda: api.read(session, remote_file),
        lambda value: "REMOTE-VERIFIED" in value["text"],
    )
    wait_for(get, lambda value: not value["running"])
    passed("real model tools execute on the selected remote machine")
    tree = api.rpc(
        "workspaceFiles/list", {"workspaceFileScopeId": session, "path": args.workspace}
    )
    assert remote_file in {item["name"] for item in tree["entries"]}
    assert finished not in {item["name"] for item in tree["entries"]}
    passed("native file browser follows the same binding")
    api.rpc(
        "workspaceFiles/read",
        {"workspaceFileScopeId": session, "path": "/etc/passwd", "range": {}},
        rejected=True,
    )
    passed("file previews enforce selected workspace containment")
    forked = api.rpc("session/fork", {"request": {"sessionId": session}})
    fork_state = api.remote(
        "get", {"sessionId": forked["sessionId"], "clientId": controller}
    )
    assert fork_state["current"] == get()["current"]
    assert fork_state["control"] is None
    passed("explicit native fork inherits binding and has independent control")
    taken = api.remote(
        "control",
        {
            "sessionId": session,
            "clientId": viewer,
            "label": "Viewer takeover",
            "takeover": True,
        },
    )
    assert taken["control"]["mine"]
    api.remote(
        "input",
        {
            "clientId": controller,
            "epoch": epoch,
            "method": "prompt",
            "payload": input_request("Do not run this."),
        },
        rejected=True,
    )
    passed("takeover rejects previous controller epoch")
    print(f"{len(checks)} DSH checks passed; verification session: {session}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url-file", type=Path, required=True)
    parser.add_argument("--origin")
    parser.add_argument("--machine", default="vps1")
    parser.add_argument("--workspace", default="/root/remote-pi-demo")
    parser.add_argument("--state-file", type=Path)
    run(parser.parse_args())

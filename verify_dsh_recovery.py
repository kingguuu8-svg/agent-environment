"""Verify cancel, a real desktop outage and VPS4 restart without replaying tools."""

import argparse
import json
import subprocess
import uuid
from pathlib import Path

from deploy_cloud_vps import python_run
from gateway import load_targets
from verify_dsh import DshApi, wait_for


def run(args):
    checks = []

    def passed(name):
        checks.append(name)
        print(f"PASS {name}", flush=True)

    def login():
        return DshApi(json.loads(args.url_file.read_text())["url"], args.origin)

    api = login()
    desktop = str(args.workspace.resolve())
    target = load_targets(args.config.resolve())["gateway"]
    cloud = next(
        item["workspace"]
        for item in api.remote("catalog", {})["machines"]
        if item["id"] == "cloud"
    )
    desktop_pick = api.remote("pick", {"machine": "desktop", "workspace": desktop})
    cloud_pick = api.remote("pick", {"machine": "cloud", "workspace": cloud})

    def create(pick):
        return api.rpc("session/create", {"request": {"cwd": pick["cwd"]}})["sessionId"]

    session = create(cloud_pick)
    cloud_reader = create(cloud_pick)
    desktop_reader = create(desktop_pick)
    client = str(uuid.uuid4())
    lease = api.remote(
        "control",
        {"sessionId": session, "clientId": client, "label": "Recovery verification"},
    )
    epoch = lease["control"]["epoch"]
    run_id = "recovery-" + uuid.uuid4().hex[:12]
    started, finished, proof, once, replayed = (
        f"{run_id}-{suffix}.txt"
        for suffix in ("started", "finished", "proof", "once", "replayed")
    )

    def get():
        return api.remote("get", {"sessionId": session, "clientId": client})

    def prompt(text):
        return api.remote(
            "input",
            {
                "clientId": client,
                "epoch": epoch,
                "method": "prompt",
                "payload": {
                    "sessionId": session,
                    "requestId": str(uuid.uuid4()),
                    "mode": "queue",
                    "content": [{"type": "text", "text": text}],
                },
            },
        )

    def switch(machine, workspace):
        return api.remote(
            "switch",
            {
                "sessionId": session,
                "clientId": client,
                "epoch": epoch,
                "revision": get()["revision"],
                "machine": machine,
                "workspace": workspace,
            },
        )

    def absent(scope, path):
        return api.rpc(
            "workspaceFiles/read",
            {"workspaceFileScopeId": scope, "path": path, "range": {}},
            rejected=True,
        )

    prompt(
        f"Use bash exactly once: printf 'STARTED\\n' > {started}; sleep 60; printf 'FINISHED\\n' > {finished}. Use the current workspace only."
    )
    wait_for(
        lambda: api.read(session, started), lambda value: "STARTED" in value["text"]
    )
    pending = switch("desktop", desktop)
    assert pending["pending"]["machine"] == "desktop" and pending["running"]
    api.remote(
        "input",
        {
            "clientId": client,
            "epoch": epoch,
            "method": "cancel",
            "payload": {"sessionId": session},
        },
    )
    wait_for(
        get,
        lambda value: not value["running"] and value["current"]["machine"] == "desktop",
    )
    assert "STARTED" in api.read(cloud_reader, started)["text"]
    absent(cloud_reader, finished)
    passed("cancel stops remote bash and commits the pending switch")

    prompt(
        f"Use write to create {proof} with exactly 'DESKTOP-RECOVERY-OK\\n', then read it. Only operate on this test file in the current workspace."
    )
    wait_for(
        lambda: api.read(session, proof),
        lambda value: "DESKTOP-RECOVERY-OK" in value["text"],
    )
    wait_for(get, lambda value: not value["running"])
    switch("cloud", cloud)
    original = get()["current"]
    try:
        subprocess.run(
            ["systemctl", "--user", "stop", "remote-dsh-device-link.service"],
            check=True,
        )
        absent(desktop_reader, proof)
        api.remote("pick", {"machine": "desktop", "workspace": desktop}, rejected=True)
        api.remote(
            "switch",
            {
                "sessionId": session,
                "clientId": client,
                "epoch": epoch,
                "revision": get()["revision"],
                "machine": "desktop",
                "workspace": desktop,
            },
            rejected=True,
        )
        assert get()["current"] == original
        assert "STARTED" in api.read(cloud_reader, started)["text"]
        passed("offline device rejects preview, pick and switch; cloud remains usable")
    finally:
        subprocess.run(
            ["systemctl", "--user", "start", "remote-dsh-device-link.service"],
            check=True,
        )
    wait_for(
        lambda: api.read(desktop_reader, proof),
        lambda value: "DESKTOP-RECOVERY-OK" in value["text"],
        timeout=90,
    )
    switch("desktop", desktop)
    passed("file browser recovers on the same device without running a model turn")

    worker_loss = """import json,os,pathlib,signal,sys
p=json.load(sys.stdin);base=pathlib.Path.home()/'.local/share/remote-mcp-demo';host=json.loads((base/'dsh-state/web-url.json').read_text())['pid'];killed=[]
for pid in pathlib.Path(f'/proc/{host}/task/{host}/children').read_text().split():
 cmd=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\\0')
 if str(base/'worker.mjs').encode() in cmd and p['workspace'].encode() in cmd:
  os.kill(int(pid),signal.SIGTERM);killed.append(pid)
print(json.dumps(killed))
"""
    assert len(json.loads(python_run(target, worker_loss, {"workspace": cloud}))) == 1
    wait_for(
        lambda: api.read(cloud_reader, started),
        lambda value: "STARTED" in value["text"],
    )
    passed("cloud file worker loss reconnects on a later request without a model turn")

    prompt(
        f"Use bash exactly once: printf 'ONCE\\n' >> {once}; sleep 60; printf 'REPLAYED\\n' > {replayed}. Use only the current workspace; do not retry this command."
    )
    wait_for(
        lambda: api.read(session, once),
        lambda value: value["text"].splitlines() == ["ONCE"],
    )
    pending = switch("cloud", cloud)
    assert pending["pending"]["machine"] == "cloud" and pending["running"]
    python_run(
        target,
        "import subprocess; subprocess.run(['systemctl','--user','restart','remote-dsh.service'],check=True)",
        {},
    )
    # Re-enter through the installed command. It refreshes a stale launch
    # capability after Host restart while keeping the fixed local Web address.
    subprocess.run(
        ["dsh", "web", "--remote", "--no-open", "--workspace", desktop],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )
    api = wait_for(login, timeout=30)
    recovered = get()
    assert recovered["current"]["machine"] == "cloud" and recovered["pending"] is None
    assert not recovered["running"]
    passed("VPS4 restart restores conversation and applies the durable pending binding")
    assert api.read(desktop_reader, once)["text"].splitlines() == ["ONCE"]
    absent(desktop_reader, replayed)
    assert "DESKTOP-RECOVERY-OK" in api.read(desktop_reader, proof)["text"]
    passed("interrupted tool is not replayed and completed target writes remain")
    api.remote(
        "input",
        {
            "clientId": client,
            "epoch": epoch,
            "method": "cancel",
            "payload": {"sessionId": session},
        },
        rejected=True,
    )
    new_lease = api.remote(
        "control",
        {
            "sessionId": session,
            "clientId": client,
            "label": "Recovery verification after restart",
        },
    )
    assert new_lease["control"]["epoch"] != epoch
    passed("restart invalidates the old input lease and permits explicit reacquisition")
    result = {
        "checks": checks,
        "sessionId": session,
        "runId": run_id,
        "machine": "desktop",
        "workspace": desktop,
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    args.output.chmod(0o600)
    print(f"{len(checks)} recovery checks passed", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--url-file", type=Path, required=True)
    parser.add_argument("--origin", default="http://127.0.0.1:3081")
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument(
        "--output", type=Path, default=Path(".local/verification-dsh-recovery.json")
    )
    run(parser.parse_args())

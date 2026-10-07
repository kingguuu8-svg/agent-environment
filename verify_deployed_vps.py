"""Verify real terminals on both VPS machines against the persistent cloud service."""

import argparse
import json
import shlex
from pathlib import Path

from gateway import load_targets
from verify_vps import ssh_run

ROOT = Path(__file__).resolve().parent
RUN_CLI = """
import json,os,shutil,subprocess,sys
p=json.load(sys.stdin)
os.chdir(p['cwd'])
r=subprocess.run([shutil.which('pi') or str(__import__('pathlib').Path.home()/'.local/bin/pi'),'--remote',*p['args']],
 input=p.get('input'),text=True,capture_output=True,timeout=240)
if r.returncode: raise RuntimeError(r.stderr[-2000:])
print(r.stdout,end='')
"""


def cli(target, cwd, args, input=None):
    return ssh_run(
        target,
        shlex.join([target["python"], "-c", RUN_CLI]),
        input=json.dumps({"cwd": cwd, "args": args, "input": input}),
        timeout=260,
    )


def run(args):
    config = load_targets(args.config.resolve())
    cloud, target = config["gateway"], config["target"]
    deployed = json.loads((ROOT / ".local/deployment-cloud.json").read_text())
    base = deployed["cloud_base"]
    cloud_workspace = deployed["cloud_workspace"]
    original_pid = ssh_run(
        cloud, "systemctl --user show remote-pi.service -p MainPID --value", timeout=20
    ).strip()
    setup = """
import json,pathlib
directory=pathlib.Path.home()/'remote-pi-demo'
directory.mkdir(exist_ok=True)
for name in ['terminal-proof.txt','terminal-detached.txt']:
 (directory/name).unlink(missing_ok=True)
(directory/'AGENTS.md').write_text('Current project marker: terminal-marker-v1\\n')
print(json.dumps(str(directory)))
"""
    workspace = json.loads(ssh_run(target, shlex.join([target["python"], "-c", setup])))
    version = ssh_run(
        target,
        shlex.join(
            [
                target["python"],
                "-c",
                "import pathlib,subprocess; subprocess.run([str(pathlib.Path.home()/'.local/bin/pi'),'--version'],check=True)",
            ]
        ),
    ).strip()
    assert version == "1.0.2", version
    first = json.loads(
        cli(
            target,
            workspace,
            [
                "--json",
                "--prompt",
                "Read AGENTS.md and report the current project marker. Use write to create terminal-proof.txt containing exactly terminal-verified followed by a newline. "
                "Use cloud__write to create terminal-cloud-proof.txt containing exactly cloud-terminal-verified followed by a newline. Read terminal-proof.txt to verify it. Remember both exact contents in this conversation.",
            ],
        )
    )
    assert first["status"] == "completed", first
    session = first["session"]
    second = json.loads(
        cli(
            cloud,
            cloud_workspace,
            [
                "--session",
                session,
                "--json",
                "--prompt",
                "What exact contents did we verify in terminal-proof.txt and terminal-cloud-proof.txt? Answer from our conversation history without tools.",
            ],
        )
    )
    assert second["session"] == session and second["status"] == "completed", second
    assert "terminal-verified" in second["result"]["assistant"]
    assert "cloud-terminal-verified" in second["result"]["assistant"]
    snapshot = json.loads(
        cli(cloud, cloud_workspace, ["--session", session, "--inspect"])
    )
    assert snapshot["workspace"]["machine"] == "vps1"
    assert snapshot["workspace"]["workspace"] == workspace
    assert len(snapshot["messages"]) > 2
    # Closing the SSH frontend after acceptance must leave the cloud task alive.
    cli(
        target,
        workspace,
        ["--session", session, "--plain"],
        input="/reconnect\n/takeover\n!sleep 1; printf 'DETACHED\\n' > terminal-detached.txt\n",
    )
    inspect_files = """
import json,pathlib,time
directory=pathlib.Path(json.loads(__import__('sys').stdin.read()))
for _ in range(100):
 if (directory/'terminal-detached.txt').exists(): break
 time.sleep(.05)
print(json.dumps({name:(directory/name).read_text() for name in ['terminal-proof.txt','terminal-detached.txt']}))
"""
    files = json.loads(
        ssh_run(
            target,
            shlex.join([target["python"], "-c", inspect_files]),
            input=json.dumps(workspace),
        )
    )
    assert files == {
        "terminal-proof.txt": "terminal-verified\n",
        "terminal-detached.txt": "DETACHED\n",
    }
    proof = ssh_run(
        cloud,
        shlex.join(
            [
                cloud["python"],
                "-c",
                "import pathlib; print((pathlib.Path("
                + repr(cloud_workspace)
                + ")/'terminal-cloud-proof.txt').read_text(),end='')",
            ]
        ),
    )
    assert proof == "cloud-terminal-verified\n"
    assert (
        ssh_run(
            cloud,
            "systemctl --user show remote-pi.service -p MainPID --value",
            timeout=20,
        ).strip()
        == original_pid
    )
    ssh_run(cloud, "systemctl --user restart remote-pi.service", timeout=45)
    ready = """
import json,pathlib,socket,time,sys
path=str(pathlib.Path(json.load(sys.stdin))/'cloud/service.sock')
for _ in range(100):
 try:
  with socket.socket(socket.AF_UNIX) as client:
   client.settimeout(.1); client.connect(path)
   client.sendall(b'{"id":"ready","command":"hello"}\\n')
   if json.loads(client.recv(65536))['type']=='response': break
 except (OSError,ValueError): time.sleep(.05)
else: raise RuntimeError('Cloud service did not become ready')
"""
    ssh_run(
        cloud,
        shlex.join([cloud["python"], "-c", ready]),
        input=json.dumps(base),
        timeout=20,
    )
    restored = json.loads(cli(target, workspace, ["--session", session, "--inspect"]))
    assert restored["id"] == session
    assert restored["focus"] == snapshot["focus"]
    assert restored["epoch"] > snapshot["epoch"]
    assert any(
        "terminal-verified" in json.dumps(message) for message in restored["messages"]
    )
    state = ssh_run(
        cloud, "systemctl --user is-active remote-pi.service", timeout=20
    ).strip()
    assert state == "active", state
    return {
        "checks": [
            "installed pi delegates ordinary flags to upstream Pi 1.0.2",
            "VPS 1 terminal uses dedicated SSH to run its model and history on VPS 4",
            "VPS 4 terminal resumes the same conversation while its workspace remains on VPS 1",
            "independent SSH reads confirm native tools wrote the correct files on both hosts",
            "the VPS 1 SSH frontend reconnects and detaches while its accepted cloud task keeps running",
            "systemd restart restores the same session, workspace, history and fresh control epoch",
        ],
        "service": state,
        "session": session,
        "target_workspace": workspace,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    report = run(parser.parse_args())
    (ROOT / ".local/verification-cloud-deployment.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report, indent=2))

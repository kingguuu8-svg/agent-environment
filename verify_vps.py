"""Deploy the prototype gateway on one VPS and verify its tools on another."""

import argparse
import asyncio
import json
import os
import shlex
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

from gateway import load_targets, ssh_args
from ssh_fixture import free_port
from verify import verify

ROOT = Path(__file__).resolve().parent
REMOTE_INSTALL = """
import json, os, pathlib, subprocess, sys
payload = json.load(sys.stdin)
base = pathlib.Path.home() / '.local/share/remote-mcp-demo'
base.mkdir(parents=True, exist_ok=True)
venv = base / 'venv'
if not (venv / 'bin/python').exists():
    subprocess.run([sys.executable, '-m', 'venv', str(venv)], check=True, stdout=sys.stderr)
subprocess.run([str(venv / 'bin/python'), '-m', 'pip', 'install', '--quiet',
               '--disable-pip-version-check', 'mcp==1.26.0', 'uvicorn==0.54.0'],
               check=True, stdout=sys.stderr, timeout=180)
for name, content in payload['files'].items():
    (base / name).write_text(content)
run = base / '.local' / payload['run_id']
run.mkdir(mode=0o700, parents=True, exist_ok=True)
(run / 'known_hosts').write_text(payload['known_hosts'])
(run / 'denied_key').write_text(payload['denied_key'])
(run / 'denied_key').chmod(0o600)
target = payload['target']
target.pop('identity_file', None)
target['known_hosts_file'] = str(run / 'known_hosts')
denied = dict(target, identity_file=str(run / 'denied_key'))
(run / 'targets.json').write_text(json.dumps({'targets': {'vps1': target, 'denied': denied}}))
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
print(json.dumps({'base': str(base), 'run': str(run), 'port': port,
                  'hostname': socket.gethostname()}))
"""


def ssh_run(target, command, *, input=None, env=None, timeout=240):
    result = subprocess.run(
        ["ssh", *ssh_args(target), command],
        input=input,
        text=True,
        capture_output=True,
        env=env,
        timeout=timeout,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return result.stdout


def run(args):
    config = load_targets(args.config.resolve())
    gateway, target = config["gateway"], config["target"]
    if not target.get("identity_file"):
        raise ValueError("The VPS check requires the target's local identity_file")
    run_id = uuid.uuid4().hex[:12]
    local = ROOT / ".local" / run_id
    local.mkdir(parents=True, mode=0o700)
    log = (local / "runtime.log").open("w")
    agent = ssh = None
    remote = None
    cleanup_errors = []
    environment = os.environ.copy()
    environment["SSH_AUTH_SOCK"] = str(local / "agent.sock")
    try:
        agent = subprocess.Popen(
            ["ssh-agent", "-D", "-a", environment["SSH_AUTH_SOCK"]],
            stdout=log,
            stderr=log,
        )
        for _ in range(50):
            if Path(environment["SSH_AUTH_SOCK"]).exists():
                break
            time.sleep(0.1)
        subprocess.run(
            ["ssh-add", "-t", "900", target["identity_file"]],
            env=environment,
            stdout=log,
            stderr=log,
            check=True,
        )
        # Forward a dedicated agent with only the selected key. No private key
        # or authorized_keys changes are needed on either VPS.
        known = subprocess.run(
            ["ssh-keygen", "-F", target["host"].split("@")[-1]],
            text=True,
            capture_output=True,
            check=True,
        ).stdout
        denied_key = local / "denied_key"
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(denied_key)],
            check=True,
        )
        target = {
            **target,
            "remote_base": f".local/share/remote-mcp-demo/{run_id}/bundle",
            "workspace": f".local/share/remote-mcp-demo/{run_id}/workspace",
        }
        payload = {
            "run_id": run_id,
            "files": {
                name: (ROOT / name).read_text()
                for name in ["gateway.py", "bootstrap.py", "worker.py"]
            },
            "known_hosts": known,
            "denied_key": denied_key.read_text(),
            "target": target,
        }
        remote = json.loads(
            ssh_run(
                gateway,
                shlex.join([gateway["python"], "-c", REMOTE_INSTALL]),
                input=json.dumps(payload),
            )
        )
        print(f"Gateway prepared on {remote['hostname']}", flush=True)
        local_port = free_port()
        launch = (
            "import os,pathlib; "
            f"base=pathlib.Path({remote['base']!r}); "
            f"run=pathlib.Path({remote['run']!r}); "
            "(run/'gateway.pid').write_text(str(os.getpid())); "
            "os.chdir(base); "
            "python=str(base/'venv/bin/python'); "
            f"os.execv(python,[python,'gateway.py','--config',str(run/'targets.json'),"
            f"'--transport','http','--port',{str(remote['port'])!r}])"
        )
        ssh = subprocess.Popen(
            [
                "ssh",
                "-A",
                "-o",
                "ExitOnForwardFailure=yes",
                "-L",
                f"127.0.0.1:{local_port}:127.0.0.1:{remote['port']}",
                *ssh_args(gateway),
                shlex.join([gateway["python"], "-c", launch]),
            ],
            env=environment,
            stdout=log,
            stderr=log,
        )
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if ssh.poll() is not None:
                raise RuntimeError((local / "runtime.log").read_text()[-3000:])
            try:
                # A client-side forward listens before the server starts; probe
                # the actual HTTP response instead of just its TCP listener.
                with socket.create_connection(
                    ("127.0.0.1", local_port), timeout=1
                ) as sock:
                    sock.sendall(
                        b"GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
                    )
                    if sock.recv(100).startswith(b"HTTP/"):
                        break
            except OSError:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("The forwarded gateway did not serve HTTP")
        result = asyncio.run(
            verify(
                argparse.Namespace(
                    url=f"http://127.0.0.1:{local_port}/mcp",
                    config=None,
                    machine="vps1",
                    denied_machine="denied",
                )
            )
        )
        assert result["target"]["hostname"] != remote["hostname"]
        if args.agent_model:
            from agent_check import check

            result["agent_check"] = check(
                f"http://127.0.0.1:{local_port}/mcp", "vps1", args.agent_model
            )
        result["gateway"] = {
            "hostname": remote["hostname"],
            "directory": remote["base"],
        }
        return result
    finally:
        if remote:
            cleanup = (
                "import os,pathlib,signal,shutil; "
                f"run=pathlib.Path({remote['run']!r}); pid_file=run/'gateway.pid'; "
                "pid=int(pid_file.read_text()) if pid_file.exists() else None; "
                "cmd=pathlib.Path('/proc/'+str(pid)+'/cmdline') if pid else None; "
                "os.kill(pid,signal.SIGTERM) if cmd and cmd.exists() and b'gateway.py' in cmd.read_bytes() else None; "
                "shutil.rmtree(run)"
            )
            try:
                ssh_run(
                    gateway, shlex.join([gateway["python"], "-c", cleanup]), timeout=20
                )
            except Exception as error:
                cleanup_errors.append(str(error))
            finally:
                if ssh and ssh.poll() is None:
                    ssh.terminate()
                    ssh.wait(timeout=10)
            target_cleanup = (
                "import pathlib,shutil; "
                f"path=pathlib.Path.home()/'.local/share/remote-mcp-demo/{run_id}'; "
                "shutil.rmtree(path,ignore_errors=True)"
            )
            try:
                ssh_run(
                    target,
                    shlex.join([target["python"], "-c", target_cleanup]),
                    timeout=20,
                )
            except Exception as error:
                cleanup_errors.append(str(error))
        if agent and agent.poll() is None:
            agent.terminate()
            agent.wait(timeout=10)
        log.close()
        for name in ("denied_key", "denied_key.pub"):
            (local / name).unlink(missing_ok=True)
        if cleanup_errors:
            print("Cleanup errors: " + "; ".join(cleanup_errors), file=sys.stderr)
            raise RuntimeError(
                "Could not clean up the test processes and scratch directories"
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument(
        "--agent-model", help="Also verify cold-start tools with OpenCode"
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / ".local/verification-vps.json"
    )
    args = parser.parse_args()
    result = run(args)
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(serialized)
    print(serialized)

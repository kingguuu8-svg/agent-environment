"""Run Pi on VPS 4 with workspace-bound tools and project context from VPS 1."""

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
import uuid
from pathlib import Path

from gateway import BUNDLE_FILES, load_targets, ssh_args
from verify_vps import REMOTE_INSTALL, ssh_run
from verify_workspace_local import WORKSPACE_SETUP

ROOT = Path(__file__).resolve().parent
PREPARE_AGENT = """
import hashlib,json,pathlib,subprocess,sys
p=json.load(sys.stdin)
base=pathlib.Path(p['base']); run=pathlib.Path(p['run'])
marker=base/'pi-dependencies.sha256'
digest=hashlib.sha256((base/'package-lock.json').read_bytes()).hexdigest()
if not marker.exists() or marker.read_text()!=digest or not (base/'node_modules').is_dir():
    subprocess.run(['npm','ci','--omit=dev','--no-audit','--no-fund'],cwd=base,
                   check=True,stdout=sys.stderr,timeout=210)
    marker.write_text(digest)
local=run/'agent-workspace'; local.mkdir()
(local/'AGENTS.md').write_text('local-context-token\\n')
agent_dir=run/'pi-agent'; agent_dir.mkdir(mode=0o700)
if p.get('models'):
    (agent_dir/'models.json').write_text(json.dumps(p['models']))
print(json.dumps({'local':str(local),'agent_dir':str(agent_dir)}))
"""


def model_config(selection):
    provider, model = selection.split("/", 1)
    config = json.loads((Path.home() / ".config/opencode/opencode.jsonc").read_text())[
        "provider"
    ][provider]
    if config.get("npm") != "@ai-sdk/openai-compatible":
        raise ValueError(
            "The VPS model check currently supports OpenAI-compatible providers"
        )
    auth = json.loads((Path.home() / ".local/share/opencode/auth.json").read_text())[
        provider
    ]
    if auth["type"] != "api":
        raise ValueError("The VPS model check requires an API credential")
    return {
        "providers": {
            provider: {
                "baseUrl": config["options"]["baseURL"],
                "api": "openai-completions",
                "apiKey": "$REMOTE_MCP_CHECK_API_KEY",
                "models": [
                    {
                        "id": model,
                        "reasoning": False,
                        "contextWindow": 200000,
                        "maxTokens": 8192,
                        "compat": {
                            "supportsDeveloperRole": False,
                            "supportsStore": False,
                        },
                    }
                ],
            }
        }
    }, auth["key"]


def run(args):
    config = load_targets(args.config.resolve())
    gateway, target = config["gateway"], config["target"]
    run_id = "workspace-" + uuid.uuid4().hex[:12]
    local = ROOT / ".local" / run_id
    local.mkdir(parents=True, mode=0o700)
    log = (local / "runtime.log").open("w")
    agent = None
    remote = None
    target_base = f".local/share/remote-mcp-demo/{run_id}"
    environment = {**os.environ, "SSH_AUTH_SOCK": str(local / "agent.sock")}
    models, api_key = (
        model_config(args.agent_model) if args.agent_model else (None, None)
    )
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
        known = subprocess.run(
            ["ssh-keygen", "-F", target["host"].split("@")[-1]],
            text=True,
            capture_output=True,
            check=True,
        ).stdout
        target = {
            **target,
            "remote_base": target_base + "/bundle",
            "workspace": target_base + "/unused-default",
        }
        payload = {
            "run_id": run_id,
            "files": {
                name: (ROOT / name).read_text()
                for name in (
                    "gateway.py",
                    "bootstrap.py",
                    "workspace_gateway.py",
                    "remote-agent.mjs",
                    "verify_workspace.mjs",
                    *BUNDLE_FILES,
                )
            },
            "known_hosts": known,
            # REMOTE_INSTALL also defines an unused denied-auth fixture.
            "denied_key": "unused workspace verification fixture",
            "target": target,
        }
        remote = json.loads(
            ssh_run(
                gateway,
                shlex.join([gateway["python"], "-c", REMOTE_INSTALL]),
                input=json.dumps(payload),
            )
        )
        paths = json.loads(
            ssh_run(
                target,
                shlex.join([target["python"], "-c", WORKSPACE_SETUP]),
                input=json.dumps({"base": target_base + "/projects"}),
            )
        )
        prepared = json.loads(
            ssh_run(
                gateway,
                shlex.join([gateway["python"], "-c", PREPARE_AGENT]),
                input=json.dumps({**remote, "models": models}),
            )
        )
        command = [
            "node",
            str(Path(remote["base"]) / "verify_workspace.mjs"),
            "--config",
            str(Path(remote["run"]) / "targets.json"),
            "--machine",
            "vps1",
            "--workspace-a",
            paths[0],
            "--workspace-b",
            paths[1],
            "--state-dir",
            str(Path(remote["run"]) / "state"),
            "--agent-dir",
            prepared["agent_dir"],
            "--require-different-host",
            "--python",
            str(Path(remote["base"]) / "venv/bin/python"),
        ]
        if args.agent_model:
            command.extend(["--model", args.agent_model])
        # Pass the model credential over the SSH channel into process memory.
        # models.json contains only the environment variable's name.
        launch = (
            "import json,os,pathlib,sys; p=json.load(sys.stdin); "
            "os.environ.update(p['env']); "
            f"pathlib.Path({str(Path(remote['run']) / 'verifier.pid')!r}).write_text(str(os.getpid())); "
            "os.chdir(p['cwd']); os.execvp(p['command'][0],p['command'])"
        )
        with (
            (local / "stdout.json").open("w") as stdout,
            (local / "stderr.log").open("w") as stderr,
        ):
            result = subprocess.run(
                [
                    "ssh",
                    "-A",
                    *ssh_args(gateway),
                    shlex.join([gateway["python"], "-c", launch]),
                ],
                input=json.dumps(
                    {
                        "command": command,
                        "cwd": prepared["local"],
                        "env": {"REMOTE_MCP_CHECK_API_KEY": api_key} if api_key else {},
                    }
                ),
                env=environment,
                stdout=stdout,
                stderr=stderr,
                text=True,
                timeout=480,
                check=False,
            )
        print((local / "stderr.log").read_text()[-9000:], file=sys.stderr)
        if result.returncode:
            raise RuntimeError(
                f"Cloud workspace check failed with exit {result.returncode}"
            )
        report = json.loads((local / "stdout.json").read_text())
        report["gateway"] = remote["hostname"]
        return report
    finally:
        cleanup_errors = []
        if remote:
            cleanup = (
                "import os,pathlib,signal,shutil; "
                f"run=pathlib.Path({remote['run']!r}); pid_file=run/'verifier.pid'; "
                "pid=int(pid_file.read_text()) if pid_file.exists() else None; "
                "cmd=pathlib.Path('/proc/'+str(pid)+'/cmdline') if pid else None; "
                "os.kill(pid,signal.SIGTERM) if cmd and cmd.exists() and b'verify_workspace.mjs' in cmd.read_bytes() else None; "
                "shutil.rmtree(run)"
            )
            try:
                ssh_run(
                    gateway, shlex.join([gateway["python"], "-c", cleanup]), timeout=20
                )
            except Exception as error:
                cleanup_errors.append(str(error))
        cleanup_target = (
            "import pathlib,shutil; "
            f"shutil.rmtree(pathlib.Path.home()/{target_base!r},ignore_errors=True)"
        )
        try:
            ssh_run(
                target, shlex.join([target["python"], "-c", cleanup_target]), timeout=20
            )
        except Exception as error:
            cleanup_errors.append(str(error))
        if agent and agent.poll() is None:
            agent.terminate()
            agent.wait(timeout=10)
        log.close()
        if cleanup_errors:
            raise RuntimeError(
                "Workspace check cleanup failed: " + "; ".join(cleanup_errors)
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument(
        "--agent-model", help="Use an existing OpenCode API provider with Pi"
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / ".local/verification-workspace-vps.json"
    )
    args = parser.parse_args()
    report = run(args)
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(serialized)
    print(serialized)

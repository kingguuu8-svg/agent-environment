"""Install a persistent Pi session service on VPS 4 and its terminal on VPS 1."""

import argparse
import json
import shlex
import subprocess
from pathlib import Path

from gateway import BUNDLE_FILES, load_targets
from verify_vps import ssh_run
from verify_workspace_vps import model_config

ROOT = Path(__file__).resolve().parent
RUNTIME_FILES = (
    "gateway.py",
    "bootstrap.py",
    "workspace_gateway.py",
    "remote-agent.mjs",
    "environment.mjs",
    "state-json.mjs",
    "cloud-agent.mjs",
    "cloud-service.mjs",
    "cloud-bridge.mjs",
    "cloud-client.mjs",
    "pi-remote.mjs",
    "pi.mjs",
    "install-client.py",
    *BUNDLE_FILES,
)

INSTALL_RUNTIME = """
import json,os,pathlib,subprocess,sys
p=json.load(sys.stdin)
base=pathlib.Path.home()/'.local/share/remote-mcp-demo'
base.mkdir(parents=True,exist_ok=True)
for name,content in p['files'].items(): (base/name).write_text(content)
subprocess.run(['npm','ci','--omit=dev','--no-audit','--no-fund'],cwd=base,check=True,stdout=sys.stderr,timeout=210)
if p['cloud']:
 venv=base/'venv'
 if not (venv/'bin/python').exists(): subprocess.run([sys.executable,'-m','venv',str(venv)],check=True,stdout=sys.stderr)
 subprocess.run([str(venv/'bin/python'),'-m','pip','install','--quiet','--disable-pip-version-check',
                 'mcp==1.26.0','uvicorn==0.54.0'],check=True,stdout=sys.stderr,timeout=180)
keys=base/'keys'; keys.mkdir(mode=0o700,exist_ok=True)
key=keys/('cloud-to-vps1' if p['cloud'] else 'terminal-to-cloud')
if not key.exists(): subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C',
 'remote-pi-cloud-tool' if p['cloud'] else 'remote-pi-terminal','-f',str(key)],check=True,stdout=sys.stderr)
bin_dir=pathlib.Path('/usr/local/bin') if os.geteuid()==0 else pathlib.Path.home()/'.local/bin'
print(json.dumps({'base':str(base),'home':str(pathlib.Path.home()),'bin':str(bin_dir),'key':str(key),'public':key.with_suffix('.pub').read_text().strip()}))
"""

AUTHORIZE = """
import json,pathlib,sys
p=json.load(sys.stdin)
directory=pathlib.Path.home()/'.ssh'; directory.mkdir(mode=0o700,exist_ok=True)
file=directory/'authorized_keys'
existing=file.read_text() if file.exists() else ''
key=p['public'].split()[1]
if key not in [part for line in existing.splitlines() for part in line.split()]:
 with file.open('a') as output:
  if existing and not existing.endswith('\\n'): output.write('\\n')
  output.write(p['options']+' '+p['public']+'\\n')
file.chmod(0o600)
"""

CONFIGURE_CLOUD = """
import json,os,pathlib,subprocess,sys
p=json.load(sys.stdin); base=pathlib.Path(p['base'])
def save(path,text):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 os.fchmod(fd,0o600)
 with os.fdopen(fd,'w') as output: output.write(text)
save(base/'cloud-targets.json',json.dumps({'targets':{'vps1':p['target']}},indent=2)+'\\n')
save(base/'target-known_hosts',p['known'])
agent=base/'cloud-pi'; agent.mkdir(mode=0o700,exist_ok=True)
save(agent/'models.json',json.dumps(p['models'],indent=2)+'\\n')
save(base/'model.env','REMOTE_MCP_CHECK_API_KEY='+json.dumps(p['api_key'])+'\\n')
workspace=base/'cloud-workspace'; workspace.mkdir(exist_ok=True)
unitdir=pathlib.Path.home()/'.config/systemd/user'; unitdir.mkdir(parents=True,exist_ok=True)
save(unitdir/'remote-pi.service',p['unit'])
subprocess.run(['systemctl','--user','daemon-reload'],check=True,stdout=sys.stderr)
subprocess.run(['systemctl','--user','enable','remote-pi.service'],check=True,stdout=sys.stderr)
subprocess.run(['systemctl','--user','restart','remote-pi.service'],check=True,stdout=sys.stderr)
save(base/'client-profile.json',json.dumps({'machine':'cloud','socket':str(base/'cloud/service.sock')},indent=2)+'\\n')
subprocess.run([sys.executable,str(base/'install-client.py'),'--profile',str(base/'client-profile.json'),'--bin-dir',p['bin']],check=True,stdout=sys.stderr)
"""

CONFIGURE_TARGET = """
import json,os,pathlib,subprocess,sys
p=json.load(sys.stdin); base=pathlib.Path(p['base'])
for name,text in [('cloud-known_hosts',p['known']),('client-profile.json',json.dumps(p['profile'],indent=2)+'\\n')]:
 fd=os.open(base/name,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as output: output.write(text)
subprocess.run([sys.executable,str(base/'install-client.py'),'--profile',str(base/'client-profile.json'),'--bin-dir',p['bin']],check=True,stdout=sys.stderr)
"""


def known_host(target):
    hostname = target["host"].split("@")[-1]
    lookup = hostname if target["port"] == 22 else f"[{hostname}]:{target['port']}"
    return subprocess.check_output(
        [
            "ssh-keygen",
            "-F",
            lookup,
            "-f",
            target.get("known_hosts_file", str(Path.home() / ".ssh/known_hosts")),
        ],
        text=True,
    )


def python_run(target, script, payload):
    return ssh_run(
        target,
        shlex.join([target["python"], "-c", script]),
        input=json.dumps(payload),
        timeout=300,
    )


def run(args):
    config = load_targets(args.config.resolve())
    gateway, target = config["gateway"], config["target"]
    models, api_key = model_config(args.agent_model)
    files = {name: (ROOT / name).read_text() for name in RUNTIME_FILES}
    cloud = json.loads(
        python_run(gateway, INSTALL_RUNTIME, {"files": files, "cloud": True})
    )
    device = json.loads(
        python_run(target, INSTALL_RUNTIME, {"files": files, "cloud": False})
    )
    state = str(Path(cloud["base"]) / "cloud")
    bridge = shlex.join(
        [
            gateway["node"],
            str(Path(cloud["base"]) / "cloud-bridge.mjs"),
            "--socket",
            str(Path(state) / "service.sock"),
        ]
    )
    python_run(target, AUTHORIZE, {"public": cloud["public"], "options": "restrict"})
    python_run(
        gateway,
        AUTHORIZE,
        {
            "public": device["public"],
            "options": 'restrict,command="'
            + bridge.replace("\\", "\\\\").replace('"', '\\"')
            + '"',
        },
    )
    remote_target = {
        **target,
        "identity_file": cloud["key"],
        "known_hosts_file": str(Path(cloud["base"]) / "target-known_hosts"),
        "remote_base": ".local/share/remote-mcp-demo/worker",
        "workspace": device["home"],
    }
    command = [
        gateway["node"],
        str(Path(cloud["base"]) / "cloud-service.mjs"),
        "--config",
        str(Path(cloud["base"]) / "cloud-targets.json"),
        "--python",
        str(Path(cloud["base"]) / "venv/bin/python"),
        "--state-dir",
        state,
        "--agent-dir",
        str(Path(cloud["base"]) / "cloud-pi"),
        "--cloud-workspace",
        str(Path(cloud["base"]) / "cloud-workspace"),
        "--model",
        args.agent_model,
    ]
    unit = "\n".join(
        [
            "[Unit]",
            "Description=Remote Pi cloud sessions",
            "",
            "[Service]",
            "Type=simple",
            f"WorkingDirectory={cloud['base']}",
            f"EnvironmentFile={cloud['base']}/model.env",
            "ExecStart=" + " ".join(json.dumps(arg) for arg in command),
            "Restart=on-failure",
            "RestartSec=12",
            "TimeoutStopSec=30",
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ]
    )
    # Linger keeps the user service running after the final SSH terminal exits.
    username = gateway["host"].split("@")[0]
    ssh_run(
        gateway,
        shlex.join(["sudo", "-n", "loginctl", "enable-linger", username]),
        timeout=30,
    )
    python_run(
        gateway,
        CONFIGURE_CLOUD,
        {
            **cloud,
            "target": remote_target,
            "known": known_host(target),
            "models": models,
            "api_key": api_key,
            "unit": unit,
        },
    )
    python_run(
        target,
        CONFIGURE_TARGET,
        {
            **device,
            "known": known_host(gateway),
            "profile": {
                "machine": "vps1",
                "cloud": {
                    "host": gateway["host"],
                    "port": gateway["port"],
                    "node": gateway["node"],
                    "base": cloud["base"],
                    "identity_file": device["key"],
                    "known_hosts_file": str(Path(device["base"]) / "cloud-known_hosts"),
                },
            },
        },
    )
    status = ssh_run(
        gateway, "systemctl --user is-active remote-pi.service", timeout=30
    ).strip()
    assert status == "active", status
    return {
        "service": status,
        "cloud_base": cloud["base"],
        "target_base": device["base"],
        "cloud_workspace": str(Path(cloud["base"]) / "cloud-workspace"),
        "target_command": str(Path(device["bin"]) / "pi") + " --remote",
        "model": args.agent_model,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--agent-model", required=True)
    args = parser.parse_args()
    report = run(args)
    path = ROOT / ".local/deployment-cloud.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))

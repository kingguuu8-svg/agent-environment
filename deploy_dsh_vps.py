"""Deploy the isolated DSH Web host to VPS4 and a restricted Web entry to VPS1."""

import argparse
import json
import shlex
from pathlib import Path

from deploy_cloud_vps import AUTHORIZE, known_host, python_run
from gateway import BUNDLE_FILES, load_targets
from verify_workspace_vps import model_config

ROOT = Path(__file__).resolve().parent
FILES = [
    *BUNDLE_FILES,
    "gateway.py",
    "bootstrap.py",
    "workspace_gateway.py",
    "environment.mjs",
    "remote-agent.mjs",
    "dsh.mjs",
    "dsh-host.mjs",
    "dsh-entry.mjs",
    "dsh-remote.mjs",
    "configure-dsh.mjs",
    "install-dsh-client.py",
]
INSTALL = """import json,pathlib,subprocess,sys,os
p=json.load(sys.stdin);base=pathlib.Path.home()/'.local/share/remote-mcp-demo';base.mkdir(parents=True,exist_ok=True)
if p['cloud'] and (pathlib.Path.home()/'.config/systemd/user/remote-dsh.service').exists():
 subprocess.run(['systemctl','--user','stop','remote-dsh.service'],check=True,stdout=sys.stderr)
for name,text in p['files'].items():
 f=base/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_text(text)
subprocess.run(['npm','ci','--omit=dev','--no-audit','--no-fund'],cwd=base,check=True,stdout=sys.stderr,timeout=240)
if p['cloud']:
 venv=base/'venv'
 if not (venv/'bin/python').exists():subprocess.run([sys.executable,'-m','venv',str(venv)],check=True,stdout=sys.stderr)
 subprocess.run([str(venv/'bin/python'),'-m','pip','install','--quiet','--disable-pip-version-check','mcp==1.26.0','uvicorn==0.54.0'],check=True,stdout=sys.stderr,timeout=180)
 subprocess.run(['npm','ci','--prefix','dsh-product','--omit=dev','--no-audit','--no-fund'],cwd=base,check=True,stdout=sys.stderr,timeout=420)
 subprocess.run(['node',str(base/'dsh-product/patch-dsh.mjs')],check=True,stdout=sys.stderr)
 subprocess.run(['node',str(base/'dsh-product/migrate-session-events.mjs'),'--home',str(base/'dsh-home'),'--state',str(base/'dsh-state')],check=True,stdout=sys.stderr)
 (base/'cloud-workspace').mkdir(exist_ok=True)
 tool=base/'keys/cloud-to-vps1';tool.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 if not tool.exists():subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','remote-dsh-cloud-tool','-f',str(tool)],check=True,stdout=sys.stderr)
else:
 (pathlib.Path.home()/'remote-pi-demo').mkdir(exist_ok=True)
key=base/'keys/dsh-web-entry';key.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
if not key.exists():subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','remote-dsh-web-entry','-f',str(key)],check=True,stdout=sys.stderr)
print(json.dumps({'base':str(base),'home':str(pathlib.Path.home()),'key':str(key),'public':key.with_suffix('.pub').read_text().strip(),'toolPublic':tool.with_suffix('.pub').read_text().strip() if p['cloud'] else None,'bin':str(pathlib.Path('/usr/local/bin') if os.geteuid()==0 else pathlib.Path.home()/'.local/bin')}))
"""
CONFIGURE = """import fcntl,json,pathlib,subprocess,sys,os
p=json.load(sys.stdin);base=pathlib.Path(p['base'])
def save(path,text):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600);os.fchmod(fd,0o600)
 with os.fdopen(fd,'w') as f:f.write(text)
targets=base/'dsh-targets.json'
with (base/'dsh-targets.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX);data=json.loads(targets.read_text()) if targets.exists() else {'targets':{}};data['targets']['vps1']=p['target'];save(targets,json.dumps(data,indent=2))
save(base/'dsh-models.json',json.dumps(p['models']))
save(base/'target-known_hosts',p['known'])
save(base/'dsh-model.env','REMOTE_MCP_CHECK_API_KEY='+json.dumps(p['api_key'])+'\\n')
subprocess.run(['node',str(base/'configure-dsh.mjs'),'--home',str(base/'dsh-home'),'--targets',str(targets),'--python',str(base/'venv/bin/python'),'--state',str(base/'dsh-state'),'--workspace',str(base/'cloud-workspace'),'--model',str(base/'dsh-models.json')],check=True,stdout=sys.stderr)
save(pathlib.Path.home()/'.config/systemd/user/remote-dsh.service',p['unit'])
subprocess.run(['systemctl','--user','daemon-reload'],check=True,stdout=sys.stderr)
subprocess.run(['systemctl','--user','enable','remote-dsh.service'],check=True,stdout=sys.stderr)
subprocess.run(['systemctl','--user','restart','remote-dsh.service'],check=True,stdout=sys.stderr)
save(base/'dsh-client-profile.json',json.dumps({'machine':'cloud','localState':str(base/'dsh-state')}))
subprocess.run([sys.executable,str(base/'install-dsh-client.py'),'--profile',str(base/'dsh-client-profile.json'),'--bin-dir',p['bin']],check=True,stdout=sys.stderr)
"""


def run(args):
    targets = load_targets(args.config.resolve())
    cloud, target = targets["gateway"], targets["target"]
    models, key = model_config(args.model)
    files = {name: (ROOT / name).read_text() for name in FILES}
    for path in (ROOT / "dsh-product").rglob("*"):
        if path.is_file() and "node_modules" not in path.parts:
            files[str(path.relative_to(ROOT))] = path.read_text()
    print("Installing pinned DSH packages on VPS4", flush=True)
    host = json.loads(python_run(cloud, INSTALL, {"files": files, "cloud": True}))
    print("Installing the VPS1 Web entry", flush=True)
    device = json.loads(
        python_run(
            target,
            INSTALL,
            {"files": {name: files[name] for name in FILES}, "cloud": False},
        )
    )
    base = Path(host["base"])
    entry = shlex.join(
        [
            cloud["node"],
            str(base / "dsh-entry.mjs"),
            "--state",
            str(base / "dsh-state"),
            "--machine",
            "vps1",
        ]
    )
    escaped = entry.replace("\\", "\\\\").replace('"', '\\"')
    python_run(
        cloud,
        AUTHORIZE,
        {
            "public": device["public"],
            "options": f'restrict,port-forwarding,permitopen="127.0.0.1:3080",command="{escaped}"',
        },
    )
    python_run(target, AUTHORIZE, {"public": host["toolPublic"], "options": "restrict"})
    remote_target = {
        **target,
        "workspace": str(Path(device["home"]) / "remote-pi-demo"),
        "label": "VPS1",
        "identity_file": str(base / "keys/cloud-to-vps1"),
        "known_hosts_file": str(base / "target-known_hosts"),
        "remote_base": ".local/share/remote-mcp-demo/worker",
    }
    command = [
        cloud["node"],
        str(base / "dsh-host.mjs"),
        "--home",
        str(base / "dsh-home"),
        "--state",
        str(base / "dsh-state"),
        "--workspace",
        str(base / "cloud-workspace"),
        "--port",
        "3080",
    ]
    unit = "\n".join(
        [
            "[Unit]",
            "Description=Remote DSH Web sessions",
            "",
            "[Service]",
            "Type=simple",
            f"WorkingDirectory={base}",
            f"EnvironmentFile={base}/dsh-model.env",
            "ExecStart=" + " ".join(json.dumps(part) for part in command),
            "Restart=on-failure",
            "RestartSec=12",
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ]
    )
    python_run(
        cloud,
        CONFIGURE,
        {
            "base": host["base"],
            "target": remote_target,
            "models": models,
            "api_key": key,
            "unit": unit,
            "bin": host["bin"],
            "known": known_host(target),
        },
    )
    profile = {
        "machine": "vps1",
        "cloud": {
            "host": cloud["host"],
            "port": cloud["port"],
            "identity_file": device["key"],
            "known_hosts_file": str(Path(device["base"]) / "dsh-cloud-known_hosts"),
            "base": host["base"],
            "node": cloud["node"],
            "webPort": 3080,
        },
    }
    install_entry = """import json,pathlib,subprocess,sys,os
p=json.load(sys.stdin);b=pathlib.Path(p['base']);k=b/'dsh-cloud-known_hosts';k.write_text(p['known']);k.chmod(0o600);f=b/'dsh-client-profile.json';f.write_text(json.dumps(p['profile']));f.chmod(0o600);subprocess.run([sys.executable,str(b/'install-dsh-client.py'),'--profile',str(f),'--bin-dir',p['bin']],check=True)
"""
    python_run(
        target,
        install_entry,
        {
            "base": device["base"],
            "known": known_host(cloud),
            "profile": profile,
            "bin": device["bin"],
        },
    )
    result = {
        "hostBase": host["base"],
        "targetBase": device["base"],
        "service": "remote-dsh.service",
        "model": args.model,
    }
    destination = ROOT / ".local/dsh-deployment.json"
    destination.write_text(json.dumps(result, indent=2))
    destination.chmod(0o600)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--model", default="cpa/gpt-6-sol")
    run(parser.parse_args())

"""Sync local DSH model settings and referenced credentials to the VPS4 Host."""

import argparse
import hashlib
import json
import socket
import subprocess
from contextlib import contextmanager
from pathlib import Path

from deploy_cloud_vps import python_run
from gateway import load_targets, ssh_args
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent
SOURCES = ["configure-dsh.mjs", "dsh-product/model-config.mjs"]

STAGE = r"""
import hashlib,json,os,pathlib,signal,socket,stat,subprocess,sys,time
p=json.load(sys.stdin);base=pathlib.Path.home()/'.local/share/remote-mcp-demo'
backup=base/'dsh-state/backups'/('model-sync-'+str(time.time_ns()));backup.mkdir(parents=True,mode=0o700)
names=[*p['sources'],'dsh-models.json','dsh-home/profiles/remote-web/cordis.patch.yml','dsh-home/.credentials.yaml']
previous={}
for name in names:
 path=base/name;previous[name]={'exists':path.exists(),'mode':stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600}
 if path.exists():
  copy=backup/name;copy.parent.mkdir(parents=True,exist_ok=True);copy.write_bytes(path.read_bytes());copy.chmod(0o600)
manifest=backup/'manifest.json';manifest.write_text(json.dumps(previous));manifest.chmod(0o600)
for name,source in p['sources'].items():
 dest=base/name;dest.write_text(source);dest.chmod(0o600)
test=backup/'validation';test.mkdir(mode=0o700)
models=json.loads((base/'dsh-models.json').read_text());models['dsh']=p['local']['dsh']
def save(path,value):path.write_text(json.dumps(value));path.chmod(0o600)
save(test/'models.json',models);save(test/'targets.json',{'targets':{}})
(test/'workspace').mkdir();(test/'home').mkdir(mode=0o700)
save(test/'home/.credentials.yaml',{'version':1,'refs':p['local']['refs']})
subprocess.run(['node',str(base/'configure-dsh.mjs'),'--home',str(test/'home'),'--state',str(test/'state'),'--workspace',str(test/'workspace'),'--targets',str(test/'targets.json'),'--python',str(base/'venv/bin/python'),'--model',str(test/'models.json')],check=True,capture_output=True)
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
with (test/'host.log').open('w') as log:
 host=subprocess.Popen(['node',str(base/'dsh-host.mjs'),'--home',str(test/'home'),'--state',str(test/'state'),'--workspace',str(test/'workspace'),'--port',str(port)],stdout=log,stderr=log,start_new_session=True)
deadline=time.monotonic()+30
while not (test/'state/web-url.json').exists():
 if host.poll() is not None or time.monotonic()>deadline:
  if host.poll() is None:os.killpg(host.pid,signal.SIGTERM)
  raise RuntimeError('Isolated model validation Host did not start; inspect private validation log')
 time.sleep(.2)
print(json.dumps({'backup':str(backup),'pid':host.pid,'port':port,'url':json.loads((test/'state/web-url.json').read_text())['url']}))
"""

APPLY = r"""
import hashlib,json,pathlib,stat,subprocess,sys
p=json.load(sys.stdin);base=pathlib.Path.home()/'.local/share/remote-mcp-demo'
protected=['dsh-targets.json','dsh-model.env','device-platform.json','dsh-state/environment-access.json','dsh-home/profiles/remote-web/package.json']
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def fingerprints():return {**{name:digest(base/name) for name in protected},'dropIn':digest(pathlib.Path.home()/'.config/systemd/user/remote-dsh.service.d/environment-access.conf'),'caddy':digest(pathlib.Path('/etc/caddy/Caddyfile'))}
before=fingerprints()
logs={str(f.relative_to(base)):digest(f) for f in (base/'dsh-home/sessions').rglob('session.v4.jsonl.zstd')}
drafts={str(f.relative_to(base)):digest(f) for f in (base/'dsh-state/drafts').glob('*.json')}
subprocess.run(['systemctl','--user','stop','remote-dsh.service'],check=True,capture_output=True)
backup=pathlib.Path(p['backup']);manifest=json.loads((backup/'manifest.json').read_text())
for name in ['dsh-models.json','dsh-home/profiles/remote-web/cordis.patch.yml','dsh-home/.credentials.yaml']:
 path=base/name;manifest[name]={'exists':path.exists(),'mode':stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600}
 if path.exists():copy=backup/name;copy.parent.mkdir(parents=True,exist_ok=True);copy.write_bytes(path.read_bytes());copy.chmod(0o600)
(backup/'manifest.json').write_text(json.dumps(manifest))
result=subprocess.run(['node',str(base/'dsh-product/model-config.mjs'),'--runtime',str(base)],input=json.dumps(p['local']),text=True,capture_output=True)
if result.returncode:raise RuntimeError('Model configuration update failed; private backup available')
assert fingerprints()==before,'Unrelated configuration changed'
subprocess.run(['systemctl','--user','start','remote-dsh.service'],check=True,capture_output=True)
assert logs=={str(f.relative_to(base)):digest(f) for f in (base/'dsh-home/sessions').rglob('session.v4.jsonl.zstd')}
assert drafts=={str(f.relative_to(base)):digest(f) for f in (base/'dsh-state/drafts').glob('*.json')}
report=json.loads(result.stdout);report.update({'sessionLogsPreserved':True,'draftFilesPreserved':True,'unrelatedConfigurationPreserved':True,'sourceHashes':{name:digest(base/name) for name in p['sources']}})
print(json.dumps(report))
"""

CLEANUP = r"""
import json,os,pathlib,shutil,signal,subprocess,sys
p=json.load(sys.stdin);base=pathlib.Path.home()/'.local/share/remote-mcp-demo';backup=pathlib.Path(p['backup'])
if p.get('pid'):
 try:os.killpg(p['pid'],signal.SIGTERM)
 except ProcessLookupError:pass
if p.get('rollback'):
 if p.get('applied'):subprocess.run(['systemctl','--user','stop','remote-dsh.service'],check=True,capture_output=True)
 for name,meta in json.loads((backup/'manifest.json').read_text()).items():
  if not p.get('applied') and name not in p['sources']:continue
  dest=base/name
  if meta['exists']:dest.write_bytes((backup/name).read_bytes());dest.chmod(meta['mode'])
  else:dest.unlink(missing_ok=True)
 if p.get('applied'):subprocess.run(['systemctl','--user','start','remote-dsh.service'],check=True,capture_output=True)
validation=backup/'validation'
if not p.get('success') and (validation/'host.log').exists():
 log=backup/'validation.log';log.write_bytes((validation/'host.log').read_bytes());log.chmod(0o600)
shutil.rmtree(validation,ignore_errors=True)
print('{}')
"""

# Return the backup location even when preparation fails, so source restoration
# does not depend on successfully starting the isolated validation Host.
_stage_prefix, _stage_work = STAGE.split("for name,source in p['sources'].items():", 1)
STAGE = (
    _stage_prefix
    + "try:\n"
    + "\n".join(
        " " + line
        for line in (
            "for name,source in p['sources'].items():" + _stage_work
        ).splitlines()
    )
    + "\nexcept Exception:\n print(json.dumps({'backup':str(backup),'error':'Isolated model preparation failed; private validation log retained','pid':host.pid if 'host' in locals() else None}))\n"
)


@contextmanager
def connection(target, port, launch_url=None):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        local_port = sock.getsockname()[1]
    options = ssh_args(target)
    tunnel = subprocess.Popen(
        [
            "ssh",
            *options[:-1],
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-L",
            f"127.0.0.1:{local_port}:127.0.0.1:{port}",
            options[-1],
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:

        def ready():
            current_url = (
                launch_url
                or json.loads(
                    python_run(
                        target,
                        "import json,pathlib; print((pathlib.Path.home()/'.local/share/remote-mcp-demo/dsh-state/web-url.json').read_text())",
                        {},
                    )
                )["url"]
            )
            try:
                return DshApi(current_url, f"http://127.0.0.1:{local_port}")
            except OSError as error:
                raise RuntimeError(
                    "Waiting for the cloud Host to finish starting"
                ) from error

        yield wait_for(ready, timeout=45)
    finally:
        tunnel.terminate()
        try:
            tunnel.wait(timeout=10)
        except subprocess.TimeoutExpired:
            tunnel.kill()
            tunnel.wait()


def snapshot(api):
    result = {}
    for item in api.rpc("session/list", {"_request": {}})["items"]:
        view = api.remote("get", {"sessionId": item["sessionId"]})
        if view["running"] or view["pending"] is not None:
            raise RuntimeError(
                "Wait until running sessions and workspace switches finish before syncing models"
            )
        result[item["sessionId"]] = {
            "cwd": item["cwd"],
            # Capacity and image limits are derived from the model catalog;
            # the durable conversation and its chosen model must stay intact.
            "projections": {
                name: item["projections"]["values"].get(name)
                for name in [
                    "title",
                    "sessionStats",
                    "agentPreset",
                    "modelSelection",
                    "remoteBinding",
                    "remoteController",
                ]
            },
            "binding": {key: view[key] for key in ["current", "pending", "revision"]},
            "draftDigest": hashlib.sha256(
                json.dumps(view["draft"], sort_keys=True).encode()
            ).hexdigest(),
        }
    catalog = api.remote("catalog", {})
    return {
        "sessions": result,
        "machines": [
            {key: item.get(key) for key in ["id", "label", "workspace"]}
            for item in catalog["machines"]
        ],
        "workspaces": sorted(catalog["savedWorkspaces"], key=lambda item: item["id"]),
        "tools": catalog["tools"],
    }


def check_catalog(api, local):
    catalog = api.rpc("session/modelCatalog", {})
    if catalog["failures"]:
        raise RuntimeError("One or more model providers could not be configured")
    actual = {
        group["id"]: {model["id"]: model for model in group["models"]}
        for group in catalog["groups"]
    }
    for provider, configuration in local["dsh"]["piAI"]["providers"].items():
        for model in configuration["models"]:
            entry = actual[provider][model["id"]]
            if "name" in model:
                assert entry["name"] == model["name"]
            if model.get("reasoningEfforts"):
                assert set(model["reasoningEfforts"]) <= {
                    effort["id"] for effort in entry["reasoning"]["efforts"]
                }
    for model in local["dsh"].get("deepseek", {}).get("models", []):
        assert model["id"] in actual["deepseek-official"]
    assert catalog["default"] == local["dsh"]["defaultSelection"]
    return {
        "default": catalog["default"],
        "groups": catalog["groups"],
        "failures": catalog["failures"],
    }


def run(args):
    local = json.loads(
        subprocess.check_output(
            [
                args.node,
                str(ROOT / "dsh-product/model-config.mjs"),
                "--home",
                str(args.home),
                "--profile",
                args.profile,
            ],
            text=True,
        )
    )
    target = load_targets(args.config.resolve())["gateway"]
    sources = {name: (ROOT / name).read_text() for name in SOURCES}
    stage = None
    applied = False
    success = False
    try:
        with connection(target, 3080) as api:
            before = snapshot(api)
        print(
            "Validating the local model settings in an isolated cloud Host…", flush=True
        )
        stage = json.loads(
            python_run(target, STAGE, {"sources": sources, "local": local})
        )
        if stage.get("error"):
            raise RuntimeError(stage["error"])
        with connection(target, stage["port"], stage["url"]) as api:
            check_catalog(api, local)
        with connection(target, 3080) as api:
            # The user can browse or update a draft during isolated validation.
            # Preserve the latest idle state immediately before maintenance.
            before = snapshot(api)
        print(
            "Syncing model settings and referenced credentials; preserving existing sessions…",
            flush=True,
        )
        applied = True
        report = json.loads(
            python_run(
                target,
                APPLY,
                {"local": local, "sources": sources, "backup": stage["backup"]},
            )
        )
        with connection(target, 3080) as api:
            after = snapshot(api)
            if after != before:
                evidence = ROOT / ".local/dsh-model-sync-state-difference.json"
                evidence.write_text(
                    json.dumps({"before": before, "after": after}, ensure_ascii=False)
                )
                evidence.chmod(0o600)
                raise RuntimeError(
                    "Existing session state changed; private comparison saved"
                )
            report["catalog"] = check_catalog(api, local)
            report["existingSessionsPreserved"] = len(before["sessions"])
        assert report["sourceHashes"] == {
            name: hashlib.sha256(source.encode()).hexdigest()
            for name, source in sources.items()
        }
        report.update(
            {
                "localProfile": args.profile,
                "backup": stage["backup"],
                "productionModelRequests": 0,
            }
        )
        path = ROOT / ".local/verification-dsh-model-sync.json"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        path.chmod(0o600)
        print(
            json.dumps(
                {
                    key: report[key]
                    for key in [
                        "providers",
                        "modelCount",
                        "default",
                        "existingSessionsPreserved",
                        "unrelatedConfigurationPreserved",
                    ]
                },
                ensure_ascii=False,
            )
        )
        success = True
    except Exception:
        if stage:
            python_run(
                target,
                CLEANUP,
                {**stage, "rollback": True, "applied": applied, "sources": SOURCES},
            )
        raise
    finally:
        if stage:
            python_run(target, CLEANUP, {**stage, "success": success})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / ".local/vps-check.json")
    parser.add_argument("--home", type=Path, default=Path.home() / ".dsh")
    parser.add_argument("--profile", default="desktop")
    parser.add_argument("--node", default="node")
    run(parser.parse_args())

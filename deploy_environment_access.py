"""Deploy the shared environment entry and write its private agent connection file."""

import argparse
import hashlib
import json
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from deploy_cloud_vps import python_run
from device_onboarding import save
from gateway import load_targets
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent
SOURCE_NAMES = ["environment-access.mjs", "dsh-product/plugin/host.mjs"]
PROJECTION_FIELDS = [
    "title",
    "sessionStats",
    "remoteBinding",
    "remoteController",
    "agentPreset",
]

DEPLOY = r"""
import hashlib,json,pathlib,shutil,stat,subprocess,sys,time,urllib.request
p=json.load(sys.stdin)
base=pathlib.Path.home()/'.local/share/remote-mcp-demo'
dropin=pathlib.Path.home()/'.config/systemd/user/remote-dsh.service.d/environment-access.conf'
access=base/'dsh-state/environment-access.json'
caddy=pathlib.Path('/etc/caddy/Caddyfile')
unit='remote-dsh.service'
def run(args,**kw):return subprocess.run(args,check=True,capture_output=True,**kw)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def private(path,data):
 path.parent.mkdir(parents=True,exist_ok=True)
 temp=path.with_name(path.name+'.environment-new');temp.write_text(data);temp.chmod(0o600);temp.replace(path)
config_names=['dsh-targets.json','dsh-models.json','dsh-model.env','device-platform.json','dsh-home/profiles/remote-web/cordis.patch.yml','dsh-home/profiles/remote-web/package.json']
configs={name:digest(base/name) for name in config_names}
logs={str(f.relative_to(base)):digest(f) for f in (base/'dsh-home/sessions').rglob('session.v4.jsonl.zstd')}
drafts={str(f.relative_to(base)):digest(f) for f in (base/'dsh-state/drafts').glob('*.json')}
registry=json.loads((base/'dsh-state/environment.json').read_text())
if access.exists():
 old=json.loads(access.read_text());assert old==p['access'],'Existing access configuration differs; keep the matching connection file'
for name,source in p['sources'].items():
 dest=base/name
 if dest.exists():assert digest(dest) in [p['expected'].get(name),hashlib.sha256(source.encode()).hexdigest()],'Managed source has an unrelated change: '+name
old_caddy=run(['sudo','-n','cat',str(caddy)],text=True).stdout
block='\n# BEGIN shared-agent-environment\n'+p['hostname']+' {\n    reverse_proxy 127.0.0.1:'+str(p['access']['port'])+'\n}\n# END shared-agent-environment\n'
if '# BEGIN shared-agent-environment' in old_caddy:
 assert block in old_caddy,'Existing managed HTTPS route differs'
 new_caddy=old_caddy
else:new_caddy=old_caddy.rstrip()+'\n'+block
backup=base/'dsh-state/backups'/('environment-access-'+str(time.time_ns()));backup.mkdir(parents=True,mode=0o700)
private(backup/'Caddyfile',old_caddy)
manifest={}
files={str(base/name):source for name,source in p['sources'].items()}
files[str(access)]=json.dumps(p['access'],indent=2)+'\n'
files[str(dropin)]='[Service]\nEnvironment=REMOTE_ENVIRONMENT_ACCESS_CONFIG='+str(access)+'\n'
for name in files:
 dest=pathlib.Path(name);meta={'exists':dest.exists(),'mode':stat.S_IMODE(dest.stat().st_mode) if dest.exists() else 0o600}
 if dest.exists():
  copy=backup/('file-'+str(len(manifest)));copy.write_bytes(dest.read_bytes());copy.chmod(0o600);meta['backup']=str(copy)
 manifest[name]=meta
private(backup/'manifest.json',json.dumps(manifest))
def restore():
 run(['systemctl','--user','stop',unit])
 for name,meta in manifest.items():
  dest=pathlib.Path(name)
  if meta['exists']:private(dest,pathlib.Path(meta['backup']).read_text());dest.chmod(meta['mode'])
  else:dest.unlink(missing_ok=True)
 run(['sudo','-n','tee',str(caddy)],input=old_caddy,text=True)
 run(['sudo','-n','systemctl','reload','caddy'])
 run(['systemctl','--user','daemon-reload']);run(['systemctl','--user','start',unit])
old_pid=run(['systemctl','--user','show',unit,'--property=MainPID','--value'],text=True).stdout.strip();assert int(old_pid)>0
run(['systemctl','--user','stop',unit])
try:
 for name,source in files.items():
  dest=pathlib.Path(name);private(dest,source)
  if name in [str(base/item) for item in p['sources']]:dest.chmod(manifest[name]['mode'])
 for name in p['sources']:run(['node','--check',str(base/name)])
 shutil.copytree(base/'dsh-home',backup/'dsh-home')
 # Avoid copying the backup into itself; only preserve the relevant state files.
 for name in ['environment.json','anchors.json','drafts']:
  src=base/'dsh-state'/name
  if src.is_dir():shutil.copytree(src,backup/'state'/name)
  elif src.exists():dest=backup/'state'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dest)
 staged=caddy.with_name('Caddyfile.environment-new')
 run(['sudo','-n','tee',str(staged)],input=new_caddy,text=True)
 run(['sudo','-n','caddy','validate','--config',str(staged),'--adapter','caddyfile'])
 run(['systemctl','--user','daemon-reload']);run(['systemctl','--user','start',unit])
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 for i in range(60):
  try:
   response=opener.open('http://127.0.0.1:'+str(p['access']['port'])+'/',timeout=2)
   assert json.loads(response.read())['version']==1;break
  except Exception:time.sleep(.5)
 else:raise RuntimeError('Environment listener failed to start')
 run(['sudo','-n','mv',str(staged),str(caddy)])
 run(['sudo','-n','systemctl','reload','caddy'])
 assert {name:digest(base/name) for name in config_names}==configs
 assert {str(f.relative_to(base)):digest(f) for f in (base/'dsh-home/sessions').rglob('session.v4.jsonl.zstd')}==logs
 assert {str(f.relative_to(base)):digest(f) for f in (base/'dsh-state/drafts').glob('*.json')}==drafts
 current=json.loads((base/'dsh-state/environment.json').read_text())
 assert {(k,v.get('kind'),v.get('machine'),v.get('workspace')) for k,v in current.items()}=={(k,v.get('kind'),v.get('machine'),v.get('workspace')) for k,v in registry.items()}
 print(json.dumps({'backup':str(backup),'sourceHashes':{name:digest(base/name) for name in p['sources']},'configHashes':configs,'sessionLogsPreserved':len(logs),'cloudDraftFilesPreserved':len(drafts),'resourceIdentitiesPreserved':len(registry),'statePreserved':True,'active':run(['systemctl','--user','is-active',unit],text=True).stdout.strip(),'oldPid':old_pid,'newPid':run(['systemctl','--user','show',unit,'--property=MainPID','--value'],text=True).stdout.strip()}))
except Exception:
 restore();raise
"""

ROLLBACK = r"""
import json,pathlib,subprocess,sys
p=json.load(sys.stdin);backup=pathlib.Path(p['backup'])
def run(args,**kw):return subprocess.run(args,check=True,capture_output=True,**kw)
run(['systemctl','--user','stop','remote-dsh.service'])
for name,meta in json.loads((backup/'manifest.json').read_text()).items():
 dest=pathlib.Path(name)
 if meta['exists']:dest.write_bytes(pathlib.Path(meta['backup']).read_bytes());dest.chmod(meta['mode'])
 else:dest.unlink(missing_ok=True)
run(['sudo','-n','tee','/etc/caddy/Caddyfile'],input=(backup/'Caddyfile').read_text(),text=True)
run(['sudo','-n','systemctl','reload','caddy'])
run(['systemctl','--user','daemon-reload']);run(['systemctl','--user','start','remote-dsh.service'])
print('Restored the previous Host and HTTPS configuration')
"""


def read_connection(path):
    match = re.search(r"```json\s*(\{.*?\})\s*```", path.read_text(), re.S)
    if not match:
        raise ValueError("Connection file must contain its JSON account fields")
    return json.loads(match.group(1))


def write_connection(path, connection):
    text = (
        "共享环境接入\n\n将本文件交给你正在使用的 Agent，并让它接入这个环境。\n\n```json\n"
        + json.dumps(connection, ensure_ascii=False, indent=2)
        + "\n```\n\n请先用自己的网络请求或终端工具 GET 上述网址，读取接入协议；随后使用账户和密钥进行 HTTP Basic 认证，列出机器、工作区和工具。根据我的任务选择目标，读取工作区上下文，再调用目标工具。入口也提供 MCP 接口。\n\n每次调用明确指定目标工作区。本机工具继续作用于本机，会话和记录保留在你当前使用的 Agent 中。该密钥允许操作账户下所有已登记资源，执行权限沿用各目标设备的登录用户；将密钥保留在私有凭据中。\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".new")
    temporary.write_text(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def api_connection(args):
    return DshApi(json.loads(args.launch_cache.read_text())["url"], args.web_origin)


def snapshot(api):
    sessions = {}
    for item in api.rpc("session/list", {"_request": {}})["items"]:
        sid = item["sessionId"]
        view = api.remote("get", {"sessionId": sid})
        assert not view["running"] and view["pending"] is None, (
            "An active conversation prevents maintenance"
        )
        sessions[sid] = {
            "cwd": item["cwd"],
            "projections": {
                name: item["projections"]["values"][name] for name in PROJECTION_FIELDS
            },
            "binding": {
                name: view[name] for name in ["current", "pending", "revision"]
            },
            "draftDigest": hashlib.sha256(
                json.dumps(view["draft"], ensure_ascii=False, sort_keys=True).encode()
            ).hexdigest(),
        }
    catalog = api.remote("catalog", {})
    return {
        "sessions": sessions,
        "workspaces": sorted(
            [
                {
                    key: item[key]
                    for key in ["machine", "workspace", "title", "workspaceId"]
                }
                for item in catalog["savedWorkspaces"]
            ],
            key=lambda item: item["workspaceId"],
        ),
        "machines": sorted(
            [
                {key: item[key] for key in ["id", "label", "workspace"]}
                for item in catalog["machines"]
            ],
            key=lambda item: item["id"],
        ),
        "tools": catalog["tools"],
    }


def probe(connection):
    import base64

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(connection["url"], timeout=15) as response:
        assert response.url == connection["url"] and response.status == 200
        info = json.loads(response.read())
    auth = (
        "Basic "
        + base64.b64encode(
            f"{connection['account']}:{connection['key']}".encode()
        ).decode()
    )

    def post(value, authorization=auth):
        request = urllib.request.Request(
            info["endpoints"]["http"],
            data=json.dumps(value).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": authorization,
            },
        )
        return json.loads(opener.open(request, timeout=200).read())

    try:
        post({"action": "list"}, "Basic invalid")
        raise AssertionError("Public endpoint accepted an invalid key")
    except urllib.error.HTTPError as error:
        assert error.code == 401
    resources = post({"action": "list"})
    probes = {}
    for machine in ["cloud", "vps1", "desktop"]:
        target = next(
            item
            for item in resources["targets"]
            if item.get("machine") == machine and item.get("workspace") != "/"
        )
        context = post({"action": "context", "target": target["id"]})
        assert context["target"]["workspace"] == target["workspace"]
        result = post(
            {
                "action": "call",
                "target": target["id"],
                "tool": "bash",
                "args": {"command": "pwd"},
            }
        )
        assert result["target"]["id"] == target["id"]
        assert target["workspace"] in result["result"]["content"][0]["text"]
        probes[machine] = {
            "contextVerified": True,
            "actualNativeTool": True,
            "toolCount": len(target["tools"]),
        }
    return {
        "trustedPublicTLS": True,
        "authorizationEnforced": True,
        "registeredResources": len(resources["targets"]),
        "machines": probes,
    }


def refresh_entry(args):
    result = subprocess.run(
        [str(args.launcher), "web", "--remote", "--no-open"],
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise RuntimeError(
            "The existing Web launcher failed to refresh its private entry"
        )


def deploy(args):
    targets = load_targets(args.config.resolve())
    ip = targets["gateway"]["host"].split("@")[-1]
    url = args.url or f"https://env.{ip}.sslip.io/"
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.path not in ["", "/"]
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
        or parsed.port
        or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}", parsed.hostname or "")
    ):
        raise ValueError("Provide an HTTPS origin, without paths or credentials")
    if (
        not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", args.account)
        or not 1 <= args.port <= 65535
    ):
        raise ValueError("Provide a valid account and loopback port")
    connection = (
        read_connection(args.output)
        if args.output.exists()
        else {
            "url": url.rstrip("/") + "/",
            "account": args.account,
            "key": secrets.token_urlsafe(32),
        }
    )
    assert (
        connection["url"] == url.rstrip("/") + "/"
        and connection["account"] == args.account
    )
    access = {
        "version": 1,
        "url": connection["url"],
        "account": connection["account"],
        "credentialHash": hashlib.sha256(
            (connection["account"] + "\0" + connection["key"]).encode()
        ).hexdigest(),
        "port": args.port,
    }
    api = api_connection(args)
    before = snapshot(api)
    save(ROOT / ".local/environment-access-existing-snapshot.json", before)
    sources = {name: (ROOT / name).read_text() for name in SOURCE_NAMES}
    expected = {}
    for name in sources:
        previous = subprocess.run(["git", "show", "HEAD:" + name], capture_output=True)
        expected[name] = (
            hashlib.sha256(previous.stdout).hexdigest()
            if previous.returncode == 0
            else None
        )
    write_connection(args.output, connection)
    deployed = None
    try:
        assert snapshot(api) == before
        deployed = json.loads(
            python_run(
                targets["gateway"],
                DEPLOY,
                {
                    "sources": sources,
                    "expected": expected,
                    "access": access,
                    "hostname": parsed.hostname,
                },
            )
        )
        save(
            ROOT / ".local/environment-access-deployment.json",
            {
                "cloud": deployed,
                "connectionFile": str(args.output.resolve()),
                "validationComplete": False,
            },
        )
        refresh_entry(args)
        api = api_connection(args)
        wait_for(lambda: snapshot(api) == before, bool, timeout=30)
        # Caddy obtains and renews the trusted certificate; credentials are never
        # sent until the public HTTPS handshake has passed normal verification.
        deadline = time.monotonic() + 150
        while True:
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                    connection["url"], timeout=10
                ) as response:
                    assert response.status == 200
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        "Public HTTPS certificate or listener did not become available"
                    ) from None
                time.sleep(2)
        public = probe(connection)
        assert snapshot(api) == before
        controllers = 0
        for sid, item in before["sessions"].items():
            owner = item["projections"]["remoteController"]
            if owner:
                assert api.remote(
                    "get", {"sessionId": sid, "clientId": owner["clientId"]}
                )["control"]["mine"]
                controllers += 1
        report = {
            "cloud": deployed,
            "connectionFile": str(args.output.resolve()),
            "validationComplete": True,
            "public": public,
            "existingSessionsPreserved": len(before["sessions"]),
            "controllersRestored": controllers,
            "workspaceGroupsPreserved": len(before["workspaces"]),
            "catalogAndDraftsPreserved": True,
            "productionModelRequests": 0,
        }
        save(ROOT / ".local/environment-access-deployment.json", report)
        print(
            json.dumps(
                {
                    "connectionFile": report["connectionFile"],
                    "url": connection["url"],
                    "public": public,
                    "existingSessionsPreserved": report["existingSessionsPreserved"],
                    "controllersRestored": controllers,
                    "workspaceGroupsPreserved": report["workspaceGroupsPreserved"],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        if deployed:
            python_run(targets["gateway"], ROLLBACK, {"backup": deployed["backup"]})
            refresh_entry(args)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / ".local/vps-check.json")
    parser.add_argument("--url")
    parser.add_argument("--account", default="kingguuu8")
    parser.add_argument("--port", type=int, default=3180)
    parser.add_argument("--output", type=Path, default=ROOT / ".local/共享环境接入.md")
    parser.add_argument(
        "--launch-cache",
        type=Path,
        default=Path.home() / ".cache/remote-dsh/a36ca3ce857334ca.json",
    )
    parser.add_argument("--web-origin", default="http://127.0.0.1:3081")
    parser.add_argument(
        "--launcher", type=Path, default=Path.home() / ".local/share/pnpm/bin/dsh"
    )
    deploy(parser.parse_args())

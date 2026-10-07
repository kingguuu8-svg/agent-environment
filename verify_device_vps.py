"""Install the downloaded Linux package on an isolated VPS1 account and clean it up."""

import argparse
import base64
import json
import re
import uuid
import zlib
from pathlib import Path

from deploy_cloud_vps import python_run
from gateway import load_targets
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent

PREPARE = r"""
import json,os,pathlib,pwd,subprocess,sys
p=json.load(sys.stdin);name=p['name']
assert name.startswith('dshcheck-') and len(name)==21
subprocess.run(['useradd','--create-home','--shell','/bin/bash',name],check=True,capture_output=True)
u=pwd.getpwnam(name);home=pathlib.Path(u.pw_dir)
workspace=home/'project space';workspace.mkdir();(workspace/'AGENTS.md').write_text('ONBOARDING-TEST-'+name)
installer=home/'dsh-connect-linux.sh';installer.write_text(p['installer']);installer.chmod(0o600)
for path in [workspace,workspace/'AGENTS.md',installer]:os.chown(path,u.pw_uid,u.pw_gid)
subprocess.run(['loginctl','enable-linger',name],check=True,capture_output=True)
subprocess.run(['systemctl','start',f'user@{u.pw_uid}.service'],check=True,capture_output=True)
print(json.dumps({'home':str(home),'workspace':str(workspace),'uid':u.pw_uid}))
"""

INSTALL = r"""
import json,os,pathlib,pwd,subprocess,sys
p=json.load(sys.stdin);home=pathlib.Path(p['home']);u=pwd.getpwnam(p['name'])
env=['env',f'XDG_RUNTIME_DIR=/run/user/{u.pw_uid}',f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{u.pw_uid}/bus','PATH=/usr/bin:/bin']
command=['runuser','-u',p['name'],'--',*env,'bash',str(home/'dsh-connect-linux.sh'),'--no-open','--name',p['name']]
r=subprocess.run(command,cwd=p['workspace'],text=True,capture_output=True,timeout=290)
log=home/'installation.log';log.write_text(r.stdout+r.stderr);log.chmod(0o600);os.chown(log,u.pw_uid,u.pw_gid)
if r.returncode:raise RuntimeError((r.stdout+r.stderr)[-2500:])
identity=json.loads((home/'.local/share/remote-dsh-device/identity.json').read_text())
assert identity['kind']=='bridge'
identity['backgroundJobs']={}
for service in ['device-bridge','device-link']:
 unit=(home/'.config/systemd/user'/('remote-dsh-'+service+'.service')).read_text()
 assert str(home/'.local/share/remote-dsh-device/app/device_supervisor.py') in unit
 job=json.loads((home/'.local/share/remote-dsh-device/jobs'/(service+'.status.json')).read_text())
 os.kill(job['pid'],0);os.kill(job['childPid'],0)
 identity['backgroundJobs'][service]={'pid':job['pid'],'childPid':job['childPid']}
print(json.dumps(identity))
"""

WEB = r"""
import http.cookiejar,json,os,pathlib,pwd,subprocess,sys,urllib.request,urllib.parse
p=json.load(sys.stdin);home=pathlib.Path(p['home']);u=pwd.getpwnam(p['name'])
env=['env',f'XDG_RUNTIME_DIR=/run/user/{u.pw_uid}',f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{u.pw_uid}/bus','PATH=/usr/bin:/bin']
command=['runuser','-u',p['name'],'--',*env,str(home/'.local/bin/dsh'),'web','--remote','--no-open','--port','3099']
r=subprocess.run(command,cwd=p['workspace'],text=True,capture_output=True,timeout=60)
if r.returncode:raise RuntimeError('Web entry failed: '+r.stderr[-1000:])
log=home/'web-launch.log';log.write_text(r.stdout+r.stderr);log.chmod(0o600);os.chown(log,u.pw_uid,u.pw_gid)
cache=list((home/'.cache/remote-dsh').glob('*.json'));assert len(cache)==1
ready=json.loads(cache[0].read_text());assert ready['machine']==p['machine'] and ready['port']==3099
browser=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
login=urllib.parse.urlsplit(ready['url'])._replace(netloc='127.0.0.1:3099').geturl()
assert browser.open(login,timeout=10).status==200
profile=json.loads((home/'.config/remote-dsh/client.json').read_text());assert profile['nativeJobs']
print(json.dumps({'webReady':True,'backgroundPid':ready['pid']}))
"""

TOOLS = r"""
import asyncio,json,pathlib,sys
from mcp import ClientSession,StdioServerParameters
from mcp.client.stdio import stdio_client
p=json.load(sys.stdin);base=pathlib.Path.home()/'.local/share/remote-mcp-demo'
def value(r):
 assert not r.isError,r.model_dump_json()
 return '\n'.join(c.text for c in r.content if c.type=='text')
async def check():
 params=StdioServerParameters(command=str(base/'venv/bin/python'),args=[str(base/'workspace_gateway.py'),'--config',str(base/'dsh-targets.json'),'--machine',p['machine'],'--workspace',p['workspace']])
 async with stdio_client(params) as (read,write):
  async with ClientSession(read,write) as client:
   await client.initialize()
   names={t.name for t in (await client.list_tools()).tools};assert {'read','write','edit','bash','grep','find','ls'}<=names
   context=json.loads((await client.read_resource('workspace://context')).contents[0].text)
   assert context['binding']['workspace']==p['workspace'] and context['binding']['uri'].startswith('device://')
   value(await client.call_tool('write',{'path':'proof.txt','content':'ONBOARD-V1\n'}))
   value(await client.call_tool('edit',{'path':'proof.txt','oldText':'V1','newText':'V2'}))
   assert 'ONBOARD-V2' in value(await client.call_tool('read',{'path':'proof.txt'}))
   assert 'proof.txt' in value(await client.call_tool('find',{'pattern':'*.txt'}))
   assert 'ONBOARD-V2' in value(await client.call_tool('grep',{'pattern':'ONBOARD-V2','path':'.'}))
   assert 'proof.txt' in value(await client.call_tool('ls',{'path':'.'}))
   assert p['workspace'] in value(await client.call_tool('bash',{'command':'pwd'}))
asyncio.run(check());print(json.dumps({'nativeTools':7}))
"""

CLEAN_TARGET = r"""
import json,pathlib,pwd,subprocess,sys
p=json.load(sys.stdin);name=p['name'];assert name.startswith('dshcheck-') and len(name)==21
try:u=pwd.getpwnam(name)
except KeyError:print('{}');sys.exit(0)
subprocess.run(['loginctl','disable-linger',name],capture_output=True)
subprocess.run(['loginctl','terminate-user',name],capture_output=True)
subprocess.run(['systemctl','stop',f'user@{u.pw_uid}.service'],capture_output=True)
subprocess.run(['pkill','-u',str(u.pw_uid)],capture_output=True)
subprocess.run(['userdel','--remove',name],check=True,capture_output=True)
print('{}')
"""

CLEAN_CLOUD = r"""
import json,pathlib,shutil,subprocess,sys
p=json.load(sys.stdin);base=pathlib.Path.home()/'.local/share/remote-mcp-demo'
subprocess.run(['systemctl','--user','stop','remote-dsh.service'],check=True,capture_output=True)
try:
 sys.path.insert(0,str(base));from device_onboarding import authorized,locked,save
 file=base/'dsh-targets.json'
 with locked(base/'dsh-targets.lock'):
  config=json.loads(file.read_text());machines={k for k,v in config['targets'].items() if v.get('label')==p['name']}
  for machine in machines:
   config['targets'].pop(machine);authorized(pathlib.Path.home(),remove=['remote-dsh-device-'+machine])
  save(file,config)
 state=base/'dsh-state';environment=json.loads((state/'environment.json').read_text())
 removed={k for k,v in environment.items() if v.get('machine') in machines}
 save(state/'environment.json',{k:v for k,v in environment.items() if k not in removed})
 anchors=json.loads((state/'anchors.json').read_text())
 save(state/'anchors.json',{k:v for k,v in anchors.items() if v.get('machine') not in machines})
 for key in removed:
  shutil.rmtree(state/'workspaces'/key,ignore_errors=True)
 for pairing in p['pairingIds']:
  receipt=state/'pairing'/pairing/'receipt.json'
  if receipt.exists():
   authorized(pathlib.Path.home(),remove=['remote-dsh-pair-'+receipt.parent.name]);shutil.rmtree(receipt.parent)
finally:subprocess.run(['systemctl','--user','start','remote-dsh.service'],check=True,capture_output=True)
print(json.dumps({'removedMachines':len(machines)}))
"""


def run(args):
    cloud, target = (
        load_targets(args.config.resolve())[role] for role in ["gateway", "target"]
    )
    api = DshApi(json.loads(args.url_file.read_text())["url"], args.origin)
    name = "dshcheck-" + uuid.uuid4().hex[:12]
    checks = []
    prepared, identity, pairing_id = None, None, None
    pairing_ids = []
    failed = True

    def passed(message):
        checks.append(message)
        print("PASS " + message, flush=True)

    try:
        package = api.remote("deviceInstaller", {"platform": "linux"})
        packed = re.search(r'base64.b64decode\("([^"]+)"\)', package["content"])[1]
        pairing = json.loads(
            json.loads(zlib.decompress(base64.b64decode(packed)))["pairing.json"]
        )
        pairing_id = pairing["pairingId"]
        pairing_ids.append(pairing_id)
        assert re.fullmatch(r"[a-f0-9]{32}", pairing_id)
        assert package["pairingId"] == pairing_id
        assert (
            api.remote("deviceInstallerStatus", {"pairingId": pairing_id})["phase"]
            == "waiting"
        )
        prepared = json.loads(
            python_run(target, PREPARE, {"name": name, "installer": package["content"]})
        )
        prepared["name"] = name
        identity = json.loads(python_run(target, INSTALL, prepared))
        passed(
            "standalone downloaded package provisions a clean Linux account and connects to VPS4"
        )
        feedback = wait_for(
            lambda: api.remote("deviceInstallerStatus", {"pairingId": pairing_id}),
            lambda value: value.get("connection", {}).get("status") == "online",
            timeout=180,
        )
        assert feedback["phase"] == "registered"
        assert feedback["machine"] == {
            "id": identity["machine"],
            "label": name,
            "workspace": prepared["workspace"],
        }
        assert "token" not in feedback and "entryPublicKey" not in feedback
        passed(
            "installer progress changes from waiting to registered and online only after a real workspace tool check"
        )
        again = json.loads(python_run(target, INSTALL, prepared))
        assert identity == again
        passed(
            "rerunning installer reuses device identity, ports and running background jobs"
        )
        fresh = api.remote("deviceInstaller", {"platform": "linux"})
        pairing_ids.append(fresh["pairingId"])
        assert (
            api.remote("deviceInstallerStatus", {"pairingId": fresh["pairingId"]})[
                "phase"
            ]
            == "waiting"
        )
        replace_package = "import json,pathlib,sys;p=json.load(sys.stdin);file=pathlib.Path(p['home'])/'dsh-connect-linux.sh';assert file.exists();file.write_text(p['installer']);print('{}')"
        python_run(target, replace_package, {**prepared, "installer": fresh["content"]})
        assert json.loads(python_run(target, INSTALL, prepared)) == identity
        acknowledged = wait_for(
            lambda: api.remote(
                "deviceInstallerStatus", {"pairingId": fresh["pairingId"]}
            ),
            lambda value: value.get("connection", {}).get("status") == "online",
            timeout=30,
        )
        assert acknowledged["machine"]["id"] == identity["machine"]
        assert acknowledged["phase"] == "registered"
        passed(
            "a fresh package on an installed device reports the original device as online and preserves identity, ports and both jobs"
        )
        api.remote("catalog", {})
        machine = identity["machine"]
        assert any(i["id"] == machine for i in api.remote("catalog", {})["machines"])
        listing = api.remote(
            "browse", {"machine": machine, "path": prepared["workspace"]}
        )
        assert listing["absolutePath"] == prepared["workspace"]
        assert '"token":' not in json.dumps(api.remote("catalog", {}))
        passed(
            "new device appears without Host restart and its directories are available in Web"
        )
        runtime = json.loads(
            python_run(
                cloud,
                "import json,pathlib;print(json.dumps({'python':str(pathlib.Path.home()/'.local/share/remote-mcp-demo/venv/bin/python')}))",
                {},
            )
        )
        cloud_runtime = {**cloud, **runtime}
        payload = {**prepared, "machine": machine}
        result = json.loads(python_run(cloud_runtime, TOOLS, payload))
        assert result["nativeTools"] == 7
        independent = json.loads(
            python_run(
                target,
                "import json,pathlib,sys;p=json.load(sys.stdin);print(json.dumps({'content':(pathlib.Path(p['workspace'])/'proof.txt').read_text()}))",
                prepared,
            )
        )
        assert independent["content"] == "ONBOARD-V2\n"
        passed(
            "VPS4 executes all seven Pi tools on the new account with independent file verification"
        )
        result = json.loads(python_run(target, WEB, payload))
        assert result["webReady"]
        passed(
            "installed dsh command opens authenticated Web through a persistent native job"
        )
        restart = r"import json,subprocess,sys;p=json.load(sys.stdin);uid=p['uid'];subprocess.run(['runuser','-u',p['name'],'--','env',f'XDG_RUNTIME_DIR=/run/user/{uid}',f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus','systemctl','--user','restart','remote-dsh-device-bridge.service','remote-dsh-device-link.service'],check=True,capture_output=True);print('{}')"
        python_run(target, restart, prepared)
        wait_link = r"""
import json,pathlib,socket,time,sys
p=json.load(sys.stdin);base=pathlib.Path.home()/'.local/share/remote-mcp-demo'
target=json.loads((base/'dsh-targets.json').read_text())['targets'][p['machine']]
deadline=time.monotonic()+60
while time.monotonic()<deadline:
 try:
  with socket.create_connection(('127.0.0.1',target['port']),timeout=2) as connection:
   connection.sendall(json.dumps({'token':target['token'],'action':'worker','workspace':p['workspace']}).encode()+b'\n')
   with connection.makefile('rb') as incoming:
    if not json.loads(incoming.readline(65536)).get('ok'):raise ValueError('Device worker is not ready')
  break
 except (OSError,ValueError):time.sleep(1)
else:raise RuntimeError('Reverse link did not reconnect')
print('{}')
"""
        python_run(cloud_runtime, wait_link, payload)
        assert json.loads(python_run(cloud_runtime, TOOLS, payload))["nativeTools"] == 7
        passed(
            "both background jobs restart after installer extraction is removed and all tools remain usable"
        )
        failed = False
    finally:
        # A partially completed claim is also removable by its unique test label.
        if failed and args.keep_on_failure:
            case = ROOT / ".local/device-vps-debug.json"
            case.write_text(
                json.dumps(
                    {
                        "name": name,
                        "pairingId": pairing_id,
                        "pairingIds": pairing_ids,
                        "prepared": prepared,
                        "identity": identity,
                    }
                )
            )
            case.chmod(0o600)
            print(
                "Isolated fixture retained for debugging; metadata is in .local/device-vps-debug.json",
                flush=True,
            )
            raise RuntimeError(
                "Verification failed; isolated fixture retained for debugging"
            )
        try:
            if pairing_id:
                catalog = api.remote("catalog", {})
                machines = {
                    entry["id"]
                    for entry in catalog["machines"]
                    if entry.get("label") == name
                }
                for entry in catalog["savedWorkspaces"]:
                    if entry.get("machine") in machines:
                        api.rpc(
                            "workspace/delete",
                            {"request": {"workspaceId": entry["workspaceId"]}},
                        )
                for item in api.rpc("session/list", {"_request": {}})["items"]:
                    assert not api.remote("get", {"sessionId": item["sessionId"]})[
                        "running"
                    ], "Cloud became busy before test cleanup"
                python_run(
                    cloud, CLEAN_CLOUD, {"name": name, "pairingIds": pairing_ids}
                )
        finally:
            python_run(target, CLEAN_TARGET, {"name": name})
    report = ROOT / ".local/verification-device-vps.json"
    report.write_text(
        json.dumps(
            {
                "checks": checks,
                "environment": "VPS4 gateway / isolated VPS1 Linux account",
                "nativePlatformsNotTested": ["macOS", "Windows"],
            },
            indent=2,
        )
    )
    print(
        f"Verified {len(checks)} deployed device checks; test account and cloud registration removed"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(".local/vps-check.json"))
    parser.add_argument("--url-file", type=Path, required=True)
    parser.add_argument("--origin", default="http://127.0.0.1:3081")
    parser.add_argument("--keep-on-failure", action="store_true")
    run(parser.parse_args())

"""Read-only public HTTPS/MCP checks from this machine and VPS1; preserve DSH state."""

import argparse
import hashlib
import json
import stat
import subprocess
from pathlib import Path

from deploy_cloud_vps import python_run
from deploy_environment_access import (
    PROJECTION_FIELDS,
    SOURCE_NAMES,
    api_connection,
    probe,
    read_connection,
    snapshot,
)
from device_onboarding import save
from gateway import load_targets

ROOT = Path(__file__).resolve().parent

HTTP_CLIENT = r"""
import base64,json,urllib.request
p=json.load(__import__('sys').stdin)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
doc=json.loads(opener.open(p['url'],timeout=15).read())
auth='Basic '+base64.b64encode((p['account']+':'+p['key']).encode()).decode()
def post(value):
 request=urllib.request.Request(doc['endpoints']['http'],data=json.dumps(value).encode(),headers={'Content-Type':'application/json','Authorization':auth})
 return json.loads(opener.open(request,timeout=200).read())
catalog=post({'action':'list'})
target=next(t for t in catalog['targets'] if t.get('machine')=='vps1' and t.get('workspace')!='/')
context=post({'action':'context','target':target['id']})
result=post({'action':'call','target':target['id'],'tool':'bash','args':{'command':'pwd'}})
assert result['target']['id']==target['id']
assert target['workspace'] in result['result']['content'][0]['text']
assert context['context']['binding']['machine']=='vps1'
print(json.dumps({'trustedPublicTLS':True,'standardLibraryOnly':True,'resourceCount':len(catalog['targets']),'selfWorkspaceVerified':True,'downloadedPackages':0,'installedClient':False}))
"""

MCP_CLIENT = r"""
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
let input='';for await(const chunk of process.stdin) input+=chunk;
const p=JSON.parse(input);
const doc=await(await fetch(p.url)).json();
const authorization='Basic '+Buffer.from(p.account+':'+p.key).toString('base64');
const client=new Client({name:'public-existing-agent-client',version:'1.0.0'});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL(doc.endpoints.mcp),{requestInit:{headers:{Authorization:authorization}}}));
 assert(client.getInstructions().includes('request action=context'));
 const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name),['environment']);
 const catalog=await client.callTool({name:'environment',arguments:{action:'list'}});
 const target=catalog.structuredContent.targets.find(t=>t.id==='cloud');
 const context=await client.callTool({name:'environment',arguments:{action:'context',target:target.id}});
 assert.equal(context.structuredContent.context.workspace,target.workspace);
 const result=await client.callTool({name:'environment',arguments:{action:'call',target:target.id,tool:'bash',args:{command:'pwd'}}});
 assert.equal(result.structuredContent.target.id,target.id);
 assert(result.content[0].text.includes(target.workspace));
 assert.equal(result.structuredContent.result.exit_code,0);
 console.log(JSON.stringify({trustedPublicTLS:true,standardMcpClient:true,serverInstructions:true,explicitTarget:true,nativeToolResult:true,nativeStructuredContent:true}));
} finally {await client.close();}
"""


def verify(args):
    assert stat.S_IMODE(args.connection.stat().st_mode) == 0o600
    assert (
        subprocess.run(
            ["git", "check-ignore", "--quiet", str(args.connection)], cwd=ROOT
        ).returncode
        == 0
    )
    connection = read_connection(args.connection)
    assert set(connection) == {"url", "account", "key"}
    assert len(connection["key"]) >= 43
    before = json.loads(
        (ROOT / ".local/environment-access-existing-snapshot.json").read_text()
    )
    api = api_connection(args)
    assert snapshot(api) == before
    public = probe(connection)
    targets = load_targets(args.config.resolve())
    other_device = json.loads(python_run(targets["target"], HTTP_CLIENT, connection))
    sdk = subprocess.run(
        [args.node, "--input-type=module", "-e", MCP_CLIENT],
        input=json.dumps(connection),
        text=True,
        capture_output=True,
        cwd=ROOT,
        timeout=90,
    )
    if sdk.returncode:
        # The transport can include headers in exception data; leave its output
        # out of the console instead of copying production credentials into logs.
        raise RuntimeError("Public MCP verification failed")
    mcp = json.loads(sdk.stdout)
    assert snapshot(api) == before
    deployed = json.loads(
        (ROOT / ".local/environment-access-deployment.json").read_text()
    )
    expected = {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in SOURCE_NAMES
    }
    assert deployed["cloud"]["sourceHashes"] == expected
    remote_hashes = json.loads(
        python_run(
            targets["gateway"],
            "import hashlib,json,pathlib,sys; p=json.load(sys.stdin); b=pathlib.Path.home()/'.local/share/remote-mcp-demo'; print(json.dumps({n:hashlib.sha256((b/n).read_bytes()).hexdigest() for n in p['names']}))",
            {"names": SOURCE_NAMES},
        )
    )
    assert remote_hashes == expected
    report = {
        "connectionFileProtected": True,
        "connectionFields": ["url", "account", "key"],
        "publicHttp": public,
        "vps1Consumer": other_device,
        "publicMcp": mcp,
        "secondReadOnlyAudit": {
            "sessionsPreserved": len(before["sessions"]),
            "workspaceGroupsPreserved": len(before["workspaces"]),
            "fieldsCompared": PROJECTION_FIELDS,
            "catalogDraftsAndControllersPreserved": True,
            "deployedSourceMatches": True,
        },
        "productionModelRequests": 0,
    }
    save(ROOT / ".local/verification-environment-access-public.json", report)
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--connection", type=Path, default=ROOT / ".local/共享环境接入.md"
    )
    parser.add_argument("--config", type=Path, default=ROOT / ".local/vps-check.json")
    parser.add_argument("--node", default="node")
    parser.add_argument(
        "--launch-cache",
        type=Path,
        default=Path.home() / ".cache/remote-dsh/a36ca3ce857334ca.json",
    )
    parser.add_argument("--web-origin", default="http://127.0.0.1:3081")
    verify(parser.parse_args())

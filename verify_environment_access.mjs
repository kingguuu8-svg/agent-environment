/** Exercise the public contract using an ordinary HTTP client and the MCP SDK. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { credentialHash } from "./environment-access.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { url, account, key, configFile, remoteWorkspace, otherWorkspace, offlineWorkspace } = JSON.parse(input);
const authorization = "Basic " + Buffer.from(`${account}:${key}`).toString("base64");
const checks = [];
function passed(name) { checks.push(name); process.stdout.write(`PASS ${name}\n`); }
async function post(value, options = {}) {
  const response = await fetch(new URL("api/environment", url), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization, ...options.headers },
    body: JSON.stringify(value), signal: options.signal,
  });
  const data = await response.json();
  assert.equal(response.status, options.status ?? 200, JSON.stringify(data));
  return data;
}
function text(result) { return result.result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"); }
function call(target, tool, args, options) { return post({ action: "call", target, tool, args }, options); }
async function exists(target, path) {
  const response = await fetch(new URL("api/environment", url), { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify({ action: "call", target, tool: "read", args: { path } }) });
  await response.json();
  assert([200, 502].includes(response.status));
  return response.status === 200;
}
async function waitFor(operation) {
  for (let index = 0; index < 80; index++) {
    if (await operation()) return;
    await delay(100);
  }
  throw new Error("Timed out waiting for native target effect");
}
const originalConfig = readFileSync(configFile, "utf8");
const mcp = new Client({ name: "existing-agent-without-dsh", version: "1.0.0" });
const second = new Client({ name: "another-existing-agent", version: "1.0.0" });
try {
  const doc = await (await fetch(url)).json();
  assert.deepEqual(Object.keys(doc.endpoints).sort(), ["http", "mcp"]);
  assert.equal(doc.authentication.type, "HTTP Basic");
  assert(doc.inputSchema.properties.action.enum.includes("context"));
  assert(!JSON.stringify(doc).includes(key));
  assert(!JSON.stringify(doc).includes(remoteWorkspace));
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  passed("URL alone describes authentication, discovery, context and execution without disclosing credentials or private resources");

  for (const auth of [undefined, "Basic " + Buffer.from(`wrong:${key}`).toString("base64"), "Basic " + Buffer.from(`${account}:wrong`).toString("base64")]) {
    const response = await fetch(doc.endpoints.http, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: '{"action":"list"}' });
    assert.equal(response.status, 401);
    assert(!JSON.stringify(await response.json()).includes(remoteWorkspace));
  }
  const queryAuth = await fetch(doc.endpoints.http + "?account=fixture&key=wrong", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"list"}' });
  assert.equal(queryAuth.status, 401);
  passed("missing credentials, wrong account, wrong key and query-string credentials cannot discover the environment");

  await post({ action: "list" }, { headers: { Origin: "https://other-origin.invalid" }, status: 403 });
  const invalid = await fetch(doc.endpoints.http, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: "{" });
  assert.equal(invalid.status, 400);
  const plain = await fetch(doc.endpoints.http, { method: "POST", headers: { Authorization: authorization, "Content-Type": "text/plain" }, body: '{"action":"list"}' });
  assert.equal(plain.status, 415);
  await post({ action: "call" }, { status: 400 });
  await post({ action: "list", extra: true }, { status: 400 });
  await post({ action: "context", target: "missing" }, { status: 404 });
  await post({ action: "workspace", machine: "unknown", workspace: remoteWorkspace }, { status: 404 });
  const oversized = await fetch(doc.endpoints.http, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify({ action: "call", target: "cloud", tool: "write", args: { path: "too-large", content: "x".repeat(doc.limits.maxBodyBytes) } }) });
  assert.equal(oversized.status, 413);
  passed("origin, JSON, body size, request schema and unknown resource boundaries are enforced");

  const before = await post({ action: "list" });
  assert(before.machines.some((item) => item.id === "laptop"));
  assert(before.targets.some((item) => item.id === "cloud" && item.tools.length === 7));
  assert(before.targets.every((item) => item.tools.every((tool) => typeof tool === "string")));
  assert(JSON.stringify(before).length < 25000);
  const remote = await post({ action: "workspace", machine: "laptop", workspace: remoteWorkspace });
  const other = await post({ action: "workspace", machine: "laptop", workspace: otherWorkspace });
  const repeated = await post({ action: "workspace", machine: "laptop", workspace: remoteWorkspace });
  assert.equal(remote.target.id, repeated.target.id);
  assert.notEqual(remote.target.id, other.target.id);
  await post({ action: "workspace", machine: "laptop", workspace: remoteWorkspace + "/missing-directory" }, { status: 422 });
  passed("existing remote directories register idempotently without a DSH client");

  const context = await post({ action: "context", target: remote.target.id });
  assert.equal(context.target.machine, "laptop");
  assert.equal(context.context.workspace, remoteWorkspace);
  assert(context.context.agents_files.some((file) => file.content.includes("REMOTE-ACCESS-INSTRUCTIONS")));
  assert.deepEqual(context.tools.map((tool) => tool.name).sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  await call(remote.target.id, "read", {}, { status: 400 });
  await call(remote.target.id, "not-a-tool", {}, { status: 400 });
  passed("real target identity, project instructions and native Pi schemas are available before execution");

  await call(remote.target.id, "write", { path: "work.txt", content: "original line\n" });
  const edit = await call(remote.target.id, "edit", { path: "work.txt", edits: [{ oldText: "original", newText: "updated" }] });
  assert(edit.result._meta["remote/pi"].diff.includes("updated"));
  assert.equal(text(await call(remote.target.id, "read", { path: "work.txt" })), "updated line\n");
  assert(text(await call(remote.target.id, "grep", { pattern: "updated", path: "." })).includes("work.txt"));
  assert(text(await call(remote.target.id, "find", { pattern: "*.txt", path: "." })).includes("work.txt"));
  assert(text(await call(remote.target.id, "ls", { path: "." })).includes("work.txt"));
  assert(text(await call(remote.target.id, "bash", { command: "pwd" })).includes(remoteWorkspace));
  const image = await call(remote.target.id, "read", { path: "tiny.png" });
  assert(image.result.content.some((item) => item.type === "image" && item.data));
  passed("all seven actual Pi tools, edit metadata and image content survive the HTTP adapter");

  const [cloudRead, otherRead, remoteRead] = await Promise.all([
    call("cloud", "read", { path: "origin.txt" }),
    call(other.target.id, "read", { path: "origin.txt" }),
    call(remote.target.id, "read", { path: "origin.txt" }),
  ]);
  assert(text(cloudRead).includes("CLOUD-ORIGIN"));
  assert(text(otherRead).includes("OTHER-ORIGIN"));
  assert(text(remoteRead).includes("REMOTE-ORIGIN"));
  passed("concurrent clients and workspaces retain explicit routing without a shared current target");

  const partial = await call(remote.target.id, "bash", { command: "node -e 'require(\"fs\").appendFileSync(\"partial.txt\",\"once\\n\");process.exit(1)'" }, { status: 502 });
  assert.equal(partial.error.execution, "may_have_executed");
  assert.equal(partial.error.retry, "inspect_target_before_retry");
  assert.equal(text(await call(remote.target.id, "read", { path: "partial.txt" })), "once\n");
  const timedOut = await call(remote.target.id, "bash", { command: "node -e 'require(\"fs\").appendFileSync(\"timeout.txt\",\"once\\n\");setTimeout(()=>{},4000)'", timeout: 0.5 }, { status: 502 });
  assert.equal(timedOut.error.execution, "may_have_executed");
  assert.equal(text(await call(remote.target.id, "read", { path: "timeout.txt" })), "once\n");
  passed("partial failures and native tool timeouts are reported as uncertain and are never replayed automatically");

  const aborted = new AbortController();
  const pending = call(remote.target.id, "bash", { command: "node -e 'require(\"fs\").writeFileSync(\"http-started\",\"1\");setTimeout(()=>require(\"fs\").writeFileSync(\"http-finished\",\"1\"),4000)'" }, { signal: aborted.signal }).then(() => "completed", () => "cancelled");
  await waitFor(() => exists(remote.target.id, "http-started"));
  aborted.abort();
  assert.equal(await pending, "cancelled");
  assert(text(await call(other.target.id, "read", { path: "origin.txt" })).includes("OTHER-ORIGIN"));
  await delay(4500);
  assert.equal(await exists(remote.target.id, "http-finished"), false);
  passed("HTTP disconnect cancels its real remote invocation while unrelated tools remain usable");

  const transport = new StreamableHTTPClientTransport(new URL(doc.endpoints.mcp), { requestInit: { headers: { Authorization: authorization } } });
  await mcp.connect(transport);
  await second.connect(new StreamableHTTPClientTransport(new URL(doc.endpoints.mcp), { requestInit: { headers: { Authorization: authorization } } }));
  const tools = await mcp.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["environment"]);
  assert(mcp.getInstructions().includes("Every tool call explicitly specifies a target ID"));
  const listed = await mcp.callTool({ name: "environment", arguments: { action: "list" } });
  assert(listed.structuredContent.targets.some((item) => item.id === remote.target.id));
  const mcpRead = await mcp.callTool({ name: "environment", arguments: { action: "call", target: other.target.id, tool: "read", args: { path: "origin.txt" } } });
  assert(mcpRead.content[0].text.includes("OTHER-ORIGIN"));
  assert.equal(mcpRead.structuredContent.target.id, other.target.id);
  const mcpImage = await mcp.callTool({ name: "environment", arguments: { action: "call", target: remote.target.id, tool: "read", args: { path: "tiny.png" } } });
  assert(mcpImage.content.some((item) => item.type === "image" && item.data));
  const mcpError = await mcp.callTool({ name: "environment", arguments: { action: "call", target: remote.target.id, tool: "read", args: {} } });
  assert.equal(mcpError.isError, true);
  assert.equal(mcpError.structuredContent.error.execution, "not_started");
  passed("unmodified MCP SDK clients discover and call the same environment with native results and errors");

  const extra = await post({ action: "context", target: "ready_service" });
  assert.equal(extra.tools.length, 2);
  const extraHttp = await call(extra.target.id, extra.tools[0].name, { message: "HTTP-NESTED-MCP" });
  assert.equal(extraHttp.result.structuredContent.accepted, true);
  assert.equal(extraHttp.result.structuredContent.message, "HTTP-NESTED-MCP");
  const extraMcp = await mcp.callTool({ name: "environment", arguments: { action: "call", target: extra.target.id, tool: extra.tools[1].name, args: { message: "MCP-NESTED-MCP" } } });
  assert.equal(extraMcp.structuredContent.result.message, "MCP-NESTED-MCP");
  await call(extra.target.id, extra.tools[0].name, { unexpected: true }, { status: 400 });
  passed("extra MCP services retain paginated discovery, schema checks and structured results through either entry");

  const duplicateBody = { jsonrpc: "2.0", id: 10000, method: "tools/call", params: { name: "environment", arguments: { action: "call", target: remote.target.id, tool: "bash", args: { command: "node -e 'require(\"fs\").appendFileSync(\"duplicate.txt\",\"once\\n\");setTimeout(()=>console.log(\"done\"),1500)'" } } } };
  const rpc = () => fetch(doc.endpoints.mcp, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": transport.sessionId }, body: JSON.stringify(duplicateBody) });
  const firstRpc = rpc();
  await waitFor(() => exists(remote.target.id, "duplicate.txt"));
  assert.equal((await rpc()).status, 409);
  assert.equal((await firstRpc).status, 200);
  assert.equal(text(await call(remote.target.id, "read", { path: "duplicate.txt" })), "once\n");
  passed("duplicate in-flight MCP request IDs are rejected while the original operation executes once");

  const mcpAbort = new AbortController();
  const mcpPending = mcp.callTool({ name: "environment", arguments: { action: "call", target: remote.target.id, tool: "bash", args: { command: "node -e 'require(\"fs\").writeFileSync(\"mcp-started\",\"1\");setTimeout(()=>require(\"fs\").writeFileSync(\"mcp-finished\",\"1\"),4000)'" } } }, undefined, { signal: mcpAbort.signal }).then(() => "completed", () => "cancelled");
  await waitFor(() => exists(remote.target.id, "mcp-started"));
  mcpAbort.abort();
  assert.equal(await mcpPending, "cancelled");
  const secondRead = await second.callTool({ name: "environment", arguments: { action: "call", target: remote.target.id, tool: "read", args: { path: "origin.txt" } } });
  assert(secondRead.content[0].text.includes("REMOTE-ORIGIN"));
  await delay(4500);
  assert.equal(await exists(remote.target.id, "mcp-finished"), false);
  passed("MCP cancellation terminates only its invocation and preserves another client's shared connection");

  const offline = await post({ action: "workspace", machine: "laptop", workspace: offlineWorkspace });
  writeFileSync(offlineWorkspace + "/offline.txt", "temporary\n");
  // Rename only the isolated target directory; its worker retains the original cwd.
  const { renameSync } = await import("node:fs");
  renameSync(offlineWorkspace, offlineWorkspace + "-hidden");
  try {
    const unavailable = await post({ action: "context", target: offline.target.id }, { status: 503 });
    assert.equal(unavailable.error.code, "target_unavailable");
    const listing = await post({ action: "list" });
    assert(listing.targets.some((item) => item.id === offline.target.id));
    assert(text(await call("cloud", "read", { path: "origin.txt" })).includes("CLOUD-ORIGIN"));
  } finally { renameSync(offlineWorkspace + "-hidden", offlineWorkspace); }
  assert.equal((await post({ action: "context", target: offline.target.id })).target.workspace, offlineWorkspace);
  passed("unavailable targets remain listed, never fall back to cloud, and recover under their original ID");

  const rotated = { ...JSON.parse(originalConfig), credentialHash: credentialHash(account, "replacement-fixture-key") };
  writeFileSync(configFile, JSON.stringify(rotated), { mode: 0o600 });
  await post({ action: "list" }, { status: 401 });
  await assert.rejects(mcp.listTools());
  const replacement = "Basic " + Buffer.from(`${account}:replacement-fixture-key`).toString("base64");
  await post({ action: "list" }, { headers: { Authorization: replacement } });
  writeFileSync(configFile, JSON.stringify({ ...rotated, enabled: false }), { mode: 0o600 });
  await post({ action: "list" }, { headers: { Authorization: replacement }, status: 401 });
  passed("credential rotation and disabling access immediately revoke HTTP and existing MCP clients");
} finally {
  writeFileSync(configFile, originalConfig, { mode: 0o600 });
  await Promise.allSettled([mcp.close(), second.close()]);
}
process.stdout.write(JSON.stringify({ checks, nativePiTools: true, actualSSH: true, modelRequests: 0, workspaceIds: ["cloud"], clientRequiresDsh: false }) + "\n");

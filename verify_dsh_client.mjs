/** Exercise the shipped input interceptor against real HTTP failures and lost replies. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";

let mode = "business-error", accepted = 0;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const envelope = JSON.parse(body);
  if (mode === "expired") { response.writeHead(401); response.end(); return; }
  if (mode === "aborted") return;
  const result = envelope.method === "remoteWorkspaces/control" ?
    { ok: true, value: { current: { id: "fixture-workspace" }, control: { mine: true, epoch: "fixture-epoch" } } } :
    { ok: false, error: { code: "gateway/bad-request", message: "所选工作区不存在。", details: {} } };
  if (envelope.method === "remoteWorkspaces/input" && mode === "lost-reply") {
    accepted++;
    response.destroy();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const source = await readFile(new URL("./dsh-product/plugin/client.js", import.meta.url), "utf8");
let definition;
const cleanup = [];
runInNewContext(source, {
  window: { __ModuleLoader__: { load(value) { definition = value; } } },
  document: {
    documentElement: { dataset: { remoteDshClient: randomUUID() } },
    createElement() { return { remove() {} }; }, head: { append() {} },
  },
  URLSearchParams, URL, location: { hash: "", search: "", href: origin },
  crypto: { randomUUID }, clearTimeout, setTimeout,
});
const plugin = definition.factory((name) => {
  if (name === "react") return {};
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
  throw new Error(`Unexpected client dependency: ${name}`);
});
const ctx = {
  connection: { rpc: { async call(channel, endpoint, payload, signal) {
    const rpcId = randomUUID();
    const response = await fetch(`${origin}${channel}/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload }), signal,
    });
    if (!response.ok) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`);
    return (await response.json()).result;
  } } },
  effect(register) { cleanup.push(register()); },
  slots: { inject() {} }, uiWorkspace: { startSession() {} },
};
plugin.apply(ctx);
const prompt = (signal) => ctx.connection.rpc.call("/api", "session/prompt", {
  args: { request: { sessionId: "session-fixture", requestId: randomUUID(), content: [{ type: "text", text: "Fixture prompt" }] } },
}, signal);
try {
  const rejected = await prompt();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.message, "所选工作区不存在。");
  console.log("PASS a real RPC business rejection keeps its cause and does not claim the cloud is offline");

  mode = "lost-reply";
  const uncertain = await prompt();
  assert.equal(uncertain.ok, false);
  assert.match(uncertain.error.message, /发送结果尚未确认/);
  assert.match(uncertain.error.message, /恢复后请先检查会话/);
  assert.equal(accepted, 1);
  console.log("PASS an accepted input with a lost HTTP reply is reported as uncertain and is never replayed");

  mode = "expired";
  const expired = await prompt();
  assert.equal(expired.ok, false);
  assert.match(expired.error.message, /云端登录已失效/);
  assert.match(expired.error.message, /dsh web --remote/);
  console.log("PASS an expired cloud login provides an actionable entry recovery instruction");

  mode = "aborted";
  const abort = new AbortController();
  const pending = prompt(abort.signal);
  abort.abort();
  const canceled = await pending;
  assert.equal(canceled.ok, false);
  assert.doesNotMatch(canceled.error.message, /云端|发送结果尚未确认/);
  console.log("PASS a caller cancellation remains a cancellation rather than a cloud outage");
} finally {
  for (const dispose of cleanup.reverse()) dispose?.();
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

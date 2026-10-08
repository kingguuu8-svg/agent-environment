/** Shared connection recovery using real Pi workers and controlled reply order. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Environment } from "./environment.mjs";

let fixture;
if (process.argv.includes("--fixture")) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  fixture = JSON.parse(input);
}
const base = await mkdtemp(join(process.cwd(), ".local/environment-recovery-"));
const cloud = join(base, "cloud"), state = join(base, "state"), target = fixture?.workspace ?? join(base, "target");
const checks = [], gates = [], operations = [];
let environment, id;
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); const value = { promise, resolve }; gates.push(value); return value; };
const outcome = (promise) => { const result = promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })); operations.push(result); return result; };
const passed = (name) => { checks.push(name); console.log("PASS " + name); };
async function checkpoint(check) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await check()) return; await delay(20); }
  throw new Error("Native recovery checkpoint did not arrive");
}
const text = (name) => readFile(join(target, name), "utf8");
const exists = async (name) => { try { await text(name); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const tool = (name) => environment.definition(id, environment.descriptors(id).find((tool) => tool.name === name));
const call = (name, args, signal) => tool(name).execute("recovery-check", args, signal);
async function proof() { assert.ok((await call("read", { path: "proof.txt" })).content.some((item) => item.text?.includes("TARGET-STILL-WORKS"))); }
function holdFailure(client, method) {
  const observed = gate(), delivery = gate(), original = client[method].bind(client);
  client[method] = async (...args) => {
    // Short test deadlines also bound SDK timers retained after stream close.
    const options = method === "callTool" ? 2 : 1;
    args[options] = { ...args[options], timeout: 3000 };
    try { return await original(...args); }
    catch (error) { observed.resolve(error); await delivery.promise; throw error; }
  };
  return { observed, delivery };
}
async function failedTool(connection, prefix) {
  const held = holdFailure(connection.client, "callTool");
  const operation = outcome(call("bash", { command: `printf 'ONCE\\n' >> ${prefix}-once.txt; sleep 60; printf 'DONE\\n' > ${prefix}-finished.txt` }));
  await checkpoint(() => exists(prefix + "-once.txt"));
  await connection.client.close();
  const error = await held.observed.promise;
  assert.equal(error.code, -32000, "fault must be an actual closed transport, rather than a deadline or fabricated error");
  return { ...held, operation };
}

try {
  await mkdir(cloud); await mkdir(state);
  if (!fixture) await mkdir(target);
  await writeFile(join(cloud, "cloud.txt"), "CLOUD-STILL-WORKS\n");
  await writeFile(join(target, "proof.txt"), "TARGET-STILL-WORKS\n");
  await writeFile(join(target, "AGENTS.md"), "INITIAL-GENERATION\n");
  environment = new Environment({ stateDir: state, config: fixture?.config, python: fixture?.python, cloudWorkspace: cloud });
  id = await environment.register(fixture?.machine ?? "cloud", target);
  const initialBinding = structuredClone(environment.get(id).context.binding);
  const old = await environment.connect(id), held = await failedTool(old, "old");
  await environment.disconnect(id);
  const recovered = await environment.connect(id); assert.notEqual(old, recovered);
  await proof();
  const running = outcome(call("bash", { command: "printf 'STARTED\\n' > new-started.txt; sleep 1; printf 'DONE\\n' > new-finished.txt" }));
  await checkpoint(() => exists("new-started.txt")); held.delivery.resolve();
  assert.equal((await held.operation).ok, false); assert.equal((await running).ok, true);
  assert.equal(environment.connections.get(id), recovered);
  assert.equal(await text("new-finished.txt"), "DONE\n");
  assert.equal(await text("old-once.txt"), "ONCE\n"); assert.equal(await exists("old-finished.txt"), false);
  assert.equal(environment.get(id).lastError, undefined);
  passed("a late actual transport failure leaves the restored connection and another session's native task intact without replaying the first mutation");

  assert.equal(await environment.disconnect(id, old), false);
  assert.equal(environment.connections.get(id), recovered); await proof();
  passed("generation-aware teardown cannot close a newer transport");

  const contextOld = await environment.connect(id), beginRead = gate(), startedRead = gate();
  const nativeContext = contextOld.fetchContext.bind(contextOld);
  const contextHeld = holdFailure(contextOld.client, "readResource");
  contextOld.fetchContext = async (signal) => { startedRead.resolve(); await beginRead.promise; return nativeContext(signal); };
  const refreshing = outcome(environment.refresh(id));
  await startedRead.promise; await contextOld.client.close(); beginRead.resolve(); await contextHeld.observed.promise;
  await environment.disconnect(id); await writeFile(join(target, "AGENTS.md"), "RECOVERED-CONTEXT\n");
  const contextNew = await environment.connect(id);
  contextHeld.delivery.resolve(); assert.equal((await refreshing).ok, true);
  assert.equal(environment.connections.get(id), contextNew);
  assert.equal(environment.get(id).lastError, undefined);
  assert.ok(environment.get(id).context.agents_files.some((item) => item.content.includes("RECOVERED-CONTEXT"))); await proof();
  passed("a failed old context read preserves the verified replacement's project instructions and availability");

  const stale = await environment.connect(id), contextReady = gate(), contextDelivery = gate();
  const fetch = stale.fetchContext.bind(stale);
  stale.fetchContext = async (signal) => { const result = await fetch(signal); contextReady.resolve(); await contextDelivery.promise; return result; };
  const staleRefresh = outcome(environment.refresh(id)); await contextReady.promise;
  await environment.disconnect(id); await writeFile(join(target, "AGENTS.md"), "LATEST-CONTEXT\n");
  const latest = await environment.connect(id); contextDelivery.resolve(); assert.equal((await staleRefresh).ok, true);
  assert.equal(environment.connections.get(id), latest);
  assert.ok(environment.get(id).context.agents_files.some((item) => item.content.includes("LATEST-CONTEXT")));
  const saved = JSON.parse(await readFile(join(state, "environment.json"), "utf8"));
  assert.ok(saved[id].context.agents_files.some((item) => item.content.includes("LATEST-CONTEXT")));
  passed("a successful but late old context response cannot replace or persist outdated project facts");

  const closing = await environment.connect(id), closeStarted = gate(), closeDelivery = gate(), close = closing.close.bind(closing);
  closing.close = async () => { await close(); closeStarted.resolve(); await closeDelivery.promise; };
  const closingFailure = await failedTool(closing, "closing"); closingFailure.delivery.resolve(); await closeStarted.promise;
  assert.equal(environment.connections.has(id), false);
  assert.ok(environment.get(id).lastError);
  const whileClosing = await environment.connect(id); await proof(); closeDelivery.resolve(); assert.equal((await closingFailure.operation).ok, false);
  assert.equal(environment.connections.get(id), whileClosing); assert.equal(environment.get(id).lastError, undefined);
  assert.equal(JSON.parse(await readFile(join(state, "environment.json"), "utf8"))[id].lastError, undefined);
  passed("recovery during slow teardown keeps its healthy state after the old close finishes");

  const current = await environment.connect(id), currentFailure = await failedTool(current, "current"); currentFailure.delivery.resolve();
  assert.equal((await currentFailure.operation).ok, false);
  assert.equal(environment.connections.has(id), false); assert.ok(environment.get(id).lastError);
  assert.equal(await text("current-once.txt"), "ONCE\n");
  await environment.refresh(id); await proof();
  assert.equal(environment.get(id).lastError, undefined);
  assert.deepEqual(environment.get(id).context.binding, initialBinding);
  passed("a genuine current failure still evicts its own connection and a later request restores the same workspace identity");

  const owned = await environment.connect(id);
  await assert.rejects(call("read", { path: "missing-file.txt" }), /missing-file|ENOENT|no such/i);
  assert.equal(environment.connections.get(id), owned); assert.equal(environment.get(id).lastError, undefined); await proof();
  passed("a native tool business failure preserves the shared transport and healthy availability");

  const cancelled = new AbortController(), otherJob = outcome(call("bash", { command: "printf 'STARTED\\n' > shared-started.txt; sleep 1; printf 'DONE\\n' > shared-finished.txt" }));
  const cancelledJob = outcome(call("bash", { command: "printf 'STARTED\\n' > cancelled-started.txt; sleep 60; printf 'DONE\\n' > cancelled-finished.txt" }, cancelled.signal));
  await checkpoint(() => exists("shared-started.txt")); await checkpoint(() => exists("cancelled-started.txt")); cancelled.abort(new Error("caller cancelled"));
  assert.equal((await cancelledJob).ok, false); assert.equal((await otherJob).ok, true);
  assert.equal(environment.connections.get(id), owned); assert.equal(environment.get(id).lastError, undefined);
  assert.equal(await exists("cancelled-finished.txt"), false); assert.equal(await text("shared-finished.txt"), "DONE\n"); await proof();
  passed("per-request cancellation stops only its native command while another session continues on the same connection");

  const cancelledRead = new AbortController(), readReady = gate(), readDelivery = gate(), contextBeforeCancel = structuredClone(environment.get(id).context), actualRead = owned.fetchContext.bind(owned);
  owned.fetchContext = async (signal) => { const result = await actualRead(signal); readReady.resolve(); await readDelivery.promise; return result; };
  const readRequest = outcome(environment.refresh(id, cancelledRead.signal)); await readReady.promise; cancelledRead.abort(new Error("read cancelled")); readDelivery.resolve();
  const cancelledResult = await readRequest; assert.equal(cancelledResult.ok, false); assert.match(cancelledResult.error.message, /read cancelled/);
  assert.equal(environment.connections.get(id), owned); assert.equal(environment.get(id).lastError, undefined);
  assert.deepEqual(environment.get(id).context, contextBeforeCancel); owned.fetchContext = actualRead; await proof();
  passed("cancellation after an actual metadata response prevents publication without closing another session's transport");

  const independent = await environment.definition("cloud", environment.descriptors("cloud").find((tool) => tool.name === "read")).execute("cloud-check", { path: "cloud.txt" });
  assert.ok(independent.content.some((item) => item.text?.includes("CLOUD-STILL-WORKS")));
  assert.deepEqual(environment.get(id).context.binding, initialBinding);
  passed("remote recovery preserves independent cloud tools and the target's original identity");
  const report = { checks, nativePiTools: true, actualSSH: !!fixture, modelRequests: 0, source: "actual MCP RPC with controlled ordering of native replies and teardown" };
  await writeFile(`.local/verification-environment-recovery${fixture ? "-ssh" : ""}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ checks: checks.length, actualSSH: !!fixture, modelRequests: 0 }));
} finally {
  for (const item of gates) item.resolve();
  await environment?.close(); await Promise.allSettled(operations);
  await rm(base, { recursive: true, force: true });
}

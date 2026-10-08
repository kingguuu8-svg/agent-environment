/** Shipped new-session flow against the native client and authenticated Host RPC. */
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const dependencies = new Map();
for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store"]) dependencies.set(name, await import(require.resolve(name)));
async function nativeClient(name, extra = "") {
  const path = name.endsWith("/client") ? require.resolve(name) : require.resolve(`${name}/package.json`).replace("package.json", "lib/client.js");
  const source = await readFile(path, "utf8"), anchor = "exports.apply = apply;";
  assert.equal(source.split(anchor).length, 2);
  let value;
  runInNewContext(source.replace(anchor, `${anchor}\n${extra}`), {
    window: { __ModuleLoader__: { load(definition) { value = definition.factory((key) => dependencies.has(key) ? dependencies.get(key) : require(key)); } } },
    crypto: webcrypto, AbortController, AbortSignal, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask,
  });
  return value;
}
dependencies.set("@deepseek-ai/dsh-api-gateway/client", await nativeClient("@deepseek-ai/dsh-api-gateway/client"));
const connection = await nativeClient("@deepseek-ai/dsh-client-connection", "exports.creationRpc = createWebConnectionRpc;");
const sessions = await nativeClient("@deepseek-ai/dsh-api-session-controller", "exports.CreationManager = SessionManager; exports.CreationSessions = ClientSessions;");
const source = config.clientSource ?? await readFile(new URL("./dsh-product/plugin/client.js", import.meta.url), "utf8");
const clients = [], checks = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check) {
  for (let attempt = 0; attempt < 1200; attempt++) { if (await check()) return; await delay(25); }
  assert.fail("new-session flow did not settle");
}
const passed = (name) => { checks.push(name); console.log("PASS " + name); };
const basicRpc = connection.creationRpc((path, init) => fetch(new URL(path, config.origin + "/"), {
  ...init, headers: { ...init.headers, Cookie: config.cookie, Origin: config.origin },
}));
async function call(endpoint, request) {
  const result = await basicRpc.call("/api", endpoint, { args: endpoint === "session/list" ? { _request: request } : { request } });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const catalog = async () => (await call("session/list", {})).items;
function client(storage = new Map(), { reload = false } = {}) {
  const cleanup = [], opened = [], committed = [], requests = [], rendered = new Map();
  let definition, selected = {}, fault = "", storageBlocked = false, heldCreate = null;
  const rpc = connection.creationRpc(async (path, init) => {
    const create = path.endsWith("/session/create");
    if (create) requests.push(JSON.parse(init.body).payload.args.request);
    if (create && fault === "offline") throw new Error("controlled offline transport");
    const response = await fetch(new URL(path, config.origin + "/"), { ...init, headers: { ...init.headers, Cookie: create && fault === "expired" ? "invalid-fixture-cookie" : config.cookie, Origin: config.origin } });
    if (create && fault === "lost-create") {
      fault = "";
      const envelope = await response.json();
      assert.equal(envelope.result.ok, true);
      committed.push(envelope.result.value.sessionId);
      throw new Error("controlled lost create reply");
    }
    if (create && heldCreate) { const held = heldCreate; heldCreate = null; await held.promise; }
    if (path.endsWith("/remoteWorkspaces/control") && fault === "lost-control") {
      fault = ""; await response.json(); throw new Error("controlled lost control reply");
    }
    return response;
  });
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { documentElement: { dataset: {} }, createElement() { return { remove() {} }; }, head: { append() {} }, addEventListener() {}, removeEventListener() {} },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { if (storageBlocked) throw new Error("storage full"); storage.set(key, value); }, removeItem: (key) => { if (storageBlocked) throw new Error("storage blocked"); storage.delete(key); } },
    performance: { getEntriesByType: () => [{ type: reload ? "reload" : "navigate" }] },
    URLSearchParams, URL, location: { hash: "", search: "", href: config.origin }, crypto: webcrypto, AbortSignal, clearTimeout, setTimeout,
  });
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useSyncExternalStore: (_subscribe, snapshot) => snapshot(), Fragment: Symbol("Fragment") };
  const plugin = definition.factory((name) => name === "react" ? React : {});
  const manager = new sessions.CreationManager({ session: { create: (request) => rpc.call("/api", "session/create", { args: { request } }) } });
  const nativeSessions = { manager, projectList() { manager.getListSnapshot(); } };
  const selection = { getSnapshot: () => selected, set: (value) => { selected = value; }, subscribe: () => () => {} };
  const ctx = {
    connection: { rpc }, sessions: { create: (options) => sessions.CreationSessions.prototype.create.call(nativeSessions, options) },
    uiWorkspace: { selection, startSession() {}, openSession(id) { opened.push(id); selected = { sessionId: id }; } },
    slots: { inject(name, register) { if (name === "shell.overlay") register(); }, register(options, component) { rendered.set(options.id, component); return () => {}; } },
    effect(register) { cleanup.push(register()); },
  };
  plugin.apply(ctx);
  const walk = (node) => node && typeof node === "object" ? [node, ...node.children.flat(Infinity).flatMap(walk)] : [];
  const view = () => walk(rendered.get("remote-new-session")());
  const boundary = {
    storage, opened, committed, requests, ctx, manager,
    fault(value) { fault = value; }, blockStorage(value) { storageBlocked = value; },
    holdCreate() { heldCreate = gate(); return heldCreate; },
    get clientId() { return storage.get("remote-dsh-controller"); },
    get error() { return view().find((node) => node.props.className === "rw-error")?.children.join("") ?? ""; },
    async start(workspaceId = config.workspaceId) { const before = opened.length; ctx.uiWorkspace.startSession(workspaceId); await waitFor(() => boundary.error || opened.length > before); },
    async button(text) { const node = view().find((node) => node.type === "button" && node.children.includes(text)); assert.ok(node, `Missing ${text} button`); await node.props.onClick(); },
    dispose() { for (const dispose of cleanup.reverse()) dispose?.(); },
  };
  clients.push(boundary);
  return boundary;
}
async function verify() {
  if (config.recovery) {
    const cold = client(new Map(config.recovery.storage), { reload: true });
    assert.match(cold.error, /上次新建/);
    const before = (await catalog()).length;
    const restored = await call("remoteWorkspaces/get", { sessionId: config.recovery.sessionId, clientId: config.recovery.ownerId });
    assert.notEqual(restored.control.epoch, config.recovery.view.control.epoch);
    assert.deepEqual({ ...restored, control: { ...restored.control, epoch: config.recovery.view.control.epoch } }, config.recovery.view);
    await cold.button("重试"); await waitFor(() => cold.opened.length === 1);
    assert.equal(cold.opened[0], config.recovery.sessionId);
    assert.equal((await catalog()).length, before);
    assert.deepEqual(await call("remoteWorkspaces/get", { sessionId: cold.opened[0], clientId: config.recovery.ownerId }), restored);
    assert.equal((await call("remoteWorkspaces/get", { sessionId: cold.opened[0], clientId: cold.clientId })).control.mine, false);
    passed("actual Host restart cold-adopts the saved identity while preserving the other device's input owner and draft");
    return { checks: checks.length };
  }
  const initial = new Set((await catalog()).map((item) => item.sessionId));
  const a = client(); a.fault("lost-create"); await a.start();
  assert.match(a.error, /lost create reply/);
  assert.equal(a.committed.length, 1);
  assert.equal((await catalog()).filter((item) => !initial.has(item.sessionId)).length, 1);
  await a.button("重试"); await waitFor(() => a.opened.length === 1);
  const added = (await catalog()).filter((item) => !initial.has(item.sessionId));
  if (config.baseline) {
    assert.equal(added.length, 2);
    assert.notEqual(a.opened[0], a.committed[0]);
    passed("baseline: a real committed create with a lost HTTP reply followed by shipped Retry creates two native sessions");
  } else {
    assert.equal(added.length, 1);
    assert.equal(a.opened[0], a.committed[0]);
    assert.equal(a.requests[0].sessionId, a.requests[1].sessionId);
    passed("Retry recovers the same actually committed native session after losing its HTTP reply");
  }
  let restartRecovery;
  if (!config.baseline) {
    const pending = (item) => new Map(JSON.parse(item.storage.get("remote-dsh-pending-creations") ?? "[]"));
    await a.start();
    assert.notEqual(a.opened[0], a.opened[1]);
    assert.equal(pending(a).size, 0);
    assert.ok(a.manager.getListSnapshot().items.some((item) => item.sessionId === a.opened[1]));
    passed("a successful subsequent plus creates a fresh identity in the real native client catalog");

    const offline = client(), beforeOffline = (await catalog()).length;
    offline.fault("offline"); await offline.start();
    const offlineId = pending(offline).get(config.workspaceId);
    assert.equal((await catalog()).length, beforeOffline);
    offline.dispose();
    const reconnect = client(offline.storage, { reload: true });
    assert.match(reconnect.error, /上次新建/);
    assert.equal(reconnect.clientId, offline.clientId);
    await reconnect.button("重试"); await waitFor(() => reconnect.opened.length === 1);
    assert.equal(reconnect.opened[0], offlineId);
    passed("a request that never reached Host retains its identity and opens once after authenticated page reload");

    const lost = client(); lost.fault("lost-create"); await lost.start();
    const lostId = lost.committed[0], beforeReload = (await catalog()).length;
    lost.dispose();
    const reload = client(lost.storage, { reload: true });
    await reload.button("重试"); await waitFor(() => reload.opened.length === 1);
    assert.equal(reload.opened[0], lostId);
    assert.equal((await catalog()).length, beforeReload);
    assert.equal(pending(reload).size, 0);
    passed("reload exposes recovery for an accepted create and opens the original session without adding another");

    const dismissed = client(); dismissed.fault("lost-create"); await dismissed.start();
    const dismissedId = dismissed.committed[0];
    await dismissed.button("关闭"); assert.equal(dismissed.error, "");
    await dismissed.start(); assert.equal(dismissed.opened[0], dismissedId);
    passed("dismissing the warning and choosing the same workspace plus recovers its unresolved identity");

    const independent = client(); independent.fault("lost-create"); await independent.start();
    const firstWorkspaceId = independent.committed[0];
    independent.fault("lost-create"); await independent.start(config.otherWorkspaceId);
    const secondWorkspaceId = independent.committed[1];
    assert.notEqual(firstWorkspaceId, secondWorkspaceId);
    assert.equal(pending(independent).size, 2);
    await independent.button("关闭");
    await independent.start(); assert.equal(independent.opened[0], firstWorkspaceId);
    assert.equal(pending(independent).get(config.otherWorkspaceId), secondWorkspaceId);
    await independent.start(config.otherWorkspaceId); assert.equal(independent.opened[1], secondWorkspaceId);
    const remoteView = await call("remoteWorkspaces/get", { sessionId: secondWorkspaceId, clientId: independent.clientId });
    assert.equal(remoteView.current.machine, "laptop");
    const read = await basicRpc.call("/api", "workspaceFiles/read", { args: { workspaceFileScopeId: secondWorkspaceId, path: "fixture-origin.txt", range: {} } });
    assert.equal(read.ok, true); assert.equal(read.value.text, "REMOTE-CREATION-PROOF");
    assert.equal(pending(independent).size, 0);
    passed("independent unresolved workspace attempts recover their own sessions and actual SSH directory, not another workspace");

    const conflict = client(new Map([["remote-dsh-pending-creations", JSON.stringify([[config.otherWorkspaceId, firstWorkspaceId]])]]));
    const conflictBefore = await call("remoteWorkspaces/get", { sessionId: firstWorkspaceId, clientId: independent.clientId });
    const conflictCount = (await catalog()).length;
    await conflict.start(config.otherWorkspaceId);
    assert.ok(conflict.error); assert.equal(conflict.opened.length, 0);
    assert.equal((await catalog()).length, conflictCount);
    assert.deepEqual(await call("remoteWorkspaces/get", { sessionId: firstWorkspaceId, clientId: independent.clientId }), conflictBefore);
    passed("native identity conflicts reject adoption into a different workspace and preserve the existing session");

    const concurrent = client(), held = concurrent.holdCreate(), beforeConcurrent = (await catalog()).length;
    const creation = concurrent.start();
    await waitFor(() => concurrent.requests.length === 1);
    concurrent.ctx.uiWorkspace.startSession(config.workspaceId);
    concurrent.ctx.uiWorkspace.startSession(config.otherWorkspaceId);
    held.resolve(); await creation;
    assert.equal(concurrent.requests.length, 1); assert.equal(concurrent.opened.length, 1);
    assert.equal((await catalog()).length, beforeConcurrent + 1);
    passed("concurrent clicks share one native creation and cannot change its requested workspace");

    const claimed = client(); claimed.fault("lost-control"); await claimed.start();
    const claimedId = pending(claimed).get(config.workspaceId);
    const claimedBefore = await call("remoteWorkspaces/get", { sessionId: claimedId, clientId: claimed.clientId });
    assert.equal(claimedBefore.control.mine, true);
    await claimed.button("重试"); await waitFor(() => claimed.opened.length === 1);
    assert.equal(claimed.opened[0], claimedId);
    assert.deepEqual(await call("remoteWorkspaces/get", { sessionId: claimedId, clientId: claimed.clientId }), claimedBefore);
    passed("a lost control acknowledgement retries the same session while retaining its binding, controller and empty draft");

    const ownerRetry = client(); ownerRetry.fault("lost-create"); await ownerRetry.start();
    const ownerId = ownerRetry.committed[0], otherOwner = randomUUID();
    const taken = await call("remoteWorkspaces/control", { sessionId: ownerId, clientId: otherOwner, label: "Other device" });
    await call("remoteWorkspaces/input", { sessionId: ownerId, clientId: otherOwner, epoch: taken.control.epoch, method: "rename", payload: { sessionId: ownerId, title: "Other device continued" } });
    await call("remoteWorkspaces/saveDraft", { sessionId: ownerId, clientId: otherOwner, epoch: taken.control.epoch, revision: taken.draft.revision, text: "OTHER-DEVICE-DRAFT", attachmentCount: 0 });
    const ownerBefore = await call("remoteWorkspaces/get", { sessionId: ownerId, clientId: otherOwner });
    await ownerRetry.button("重试"); await waitFor(() => ownerRetry.opened.length === 1);
    assert.equal(ownerRetry.opened[0], ownerId);
    assert.equal((await call("remoteWorkspaces/get", { sessionId: ownerId, clientId: ownerRetry.clientId })).control.mine, false);
    assert.deepEqual(await call("remoteWorkspaces/get", { sessionId: ownerId, clientId: otherOwner }), ownerBefore);
    assert.equal((await catalog()).find((item) => item.sessionId === ownerId).projections.values.title, "Other device continued");
    passed("another device can continue an uncertain create; recovery opens as viewer and preserves that owner's title and draft");

    const blocked = client(), beforeBlocked = (await catalog()).length;
    blocked.blockStorage(true); await blocked.start();
    assert.match(blocked.error, /无法保存/); assert.equal(blocked.requests.length, 0);
    assert.equal((await catalog()).length, beforeBlocked);
    blocked.blockStorage(false); await blocked.button("重试"); await waitFor(() => blocked.opened.length === 1);
    assert.equal((await catalog()).length, beforeBlocked + 1);
    passed("unavailable browser storage rejects before creating anything and can recover after storage is available");

    const expired = client(), beforeExpired = (await catalog()).length;
    expired.fault("expired"); await expired.start();
    assert.match(expired.error, /HTTP 401/); assert.equal((await catalog()).length, beforeExpired);
    const expiredId = pending(expired).get(config.workspaceId);
    expired.fault(""); await expired.button("重试"); await waitFor(() => expired.opened.length === 1);
    assert.equal(expired.opened[0], expiredId); assert.equal((await catalog()).length, beforeExpired + 1);
    passed("a real expired login creates nothing; authenticated retry keeps its retained identity");

    const cleanup = client(), cleanupHeld = cleanup.holdCreate();
    const cleanupCreation = cleanup.start(); await waitFor(() => cleanup.requests.length === 1);
    cleanup.blockStorage(true); cleanupHeld.resolve(); await cleanupCreation;
    assert.equal(cleanup.opened.length, 1); assert.equal(cleanup.error, "");
    assert.equal(pending(cleanup).get(config.workspaceId), cleanup.opened[0]);
    const beforeCleanupRetry = (await catalog()).length;
    cleanup.blockStorage(false); await cleanup.start();
    assert.equal(cleanup.opened[1], cleanup.opened[0]); assert.equal(pending(cleanup).size, 0);
    assert.equal((await catalog()).length, beforeCleanupRetry);
    passed("storage becoming unavailable after creation preserves recovery while keeping the successfully opened session usable");

    const corrupt = client(new Map([["remote-dsh-pending-creations", JSON.stringify([[config.workspaceId, "invalid-id"]])]]));
    assert.equal(corrupt.error, ""); await corrupt.start();
    assert.match(corrupt.opened[0], /^session-/);
    passed("invalid retained identities are ignored and cannot become native creation requests");

    {
      const cold = client(); cold.fault("lost-create"); await cold.start();
      const sessionId = cold.committed[0], ownerId = randomUUID();
      const view = await call("remoteWorkspaces/control", { sessionId, clientId: ownerId, label: "Restart owner" });
      await call("remoteWorkspaces/saveDraft", { sessionId, clientId: ownerId, epoch: view.control.epoch, revision: view.draft.revision, text: "RESTART-OWNER-DRAFT", attachmentCount: 0 });
      restartRecovery = { sessionId, ownerId, storage: [...cold.storage], view: await call("remoteWorkspaces/get", { sessionId, clientId: ownerId }) };
    }
  }
  return { checks: checks.length, baseline: !!config.baseline, restartRecovery, scope: "isolated native client and Host, no production changes" };
}
try { console.log(JSON.stringify(await verify())); }
finally { for (const item of clients) item.dispose(); }

/** Shipped draft synchronization against authenticated, isolated native DSH RPC. */
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

let configText = "";
for await (const chunk of process.stdin) configText += chunk;
const config = JSON.parse(configText);
const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const { createSnapshotStore } = await import(require.resolve("@deepseek-ai/dsh-client-store"));
const clientSource = await readFile(new URL("./dsh-product/plugin/client.js", import.meta.url), "utf8");
const connectionSource = await readFile(require.resolve("@deepseek-ai/dsh-client-connection/package.json").replace("package.json", "lib/client.js"), "utf8");
const anchor = "exports.apply = apply;";
assert.equal(connectionSource.split(anchor).length, 2);
let native;
runInNewContext(connectionSource.replace(anchor, `${anchor}\nexports.draftRpc = createWebConnectionRpc;`), {
  window: { __ModuleLoader__: { load(value) { native = value.factory(require); } } },
  crypto: webcrypto, AbortController, AbortSignal, URL, TextEncoder, TextDecoder,
});
const rpc = native.draftRpc((path, init) => fetch(new URL(path, config.origin + "/"), {
  ...init, headers: { ...init.headers, Cookie: config.cookie, Origin: config.origin },
}));
async function call(endpoint, request, signal) {
  const result = await rpc.call("/api", endpoint, { args: { request } }, signal);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const remote = (method, request, signal) => call(`remoteWorkspaces/${method}`, request, signal);
const create = async () => (await call("session/create", { workspaceId: config.workspaceId })).sessionId;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await delay(25); }
  assert.fail("cloud draft did not settle");
}
const checks = [];
const passed = (name) => { checks.push(name); console.log("PASS " + name); };
const clients = [];
function client(storage = new Map()) {
  const clientId = randomUUID(), inputs = new Map(), timers = new Set();
  let definition, notifications = 0;
  runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    AbortSignal,
    setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  });
  const plugin = definition.factory((name) => {
    if (name === "react" || name === "@deepseek-ai/dsh-client-ui-primitives") return {};
    throw new Error(`Unexpected dependency ${name}`);
  });
  const boundary = {
    clientId, storage, timers, save: (request, signal) => remote("saveDraft", request, signal),
    input(id, text = "") {
      if (!inputs.has(id)) {
        const state = createSnapshotStore({ draft: text, draftRev: 0, attachmentIds: [], phase: "plain" });
        inputs.set(id, { state, setDraft(text) { state.update((next) => { next.draft = text; next.draftRev++; }); },
          attachments(ids) { state.update((next) => { next.attachmentIds = ids; }); } });
      }
      return inputs.get(id);
    },
    control(id, takeover = false) { return remote("control", { sessionId: id, clientId, takeover, label: "Draft test device" }); },
    view(id) { return remote("get", { sessionId: id, clientId }); },
    get notifications() { return notifications; },
  };
  boundary.sync = plugin.createCloudDraftSync({ clientId, getInput: (id) => boundary.input(id),
    save: (request, signal) => boundary.save(request, signal), notify: () => notifications++ });
  clients.push(boundary);
  return boundary;
}
async function send(client, id, view, text) {
  return remote("input", { sessionId: id, clientId: client.clientId, epoch: view.control.epoch, method: "prompt", draftAck: true,
    payload: { sessionId: id, requestId: randomUUID(), mode: "queue", content: [{ type: "text", text }] } });
}
try {
  const id = await create(), a = client(), b = client(), c = client();
  a.sync.receive(id, await a.control(id)); a.sync.attach(id);
  a.input(id).setDraft("设备 A 尚未发送\n继续这个项目。");
  await waitFor(async () => (await a.view(id)).draft.text === a.input(id).state.getSnapshot().draft);
  b.sync.receive(id, await b.control(id)); b.sync.attach(id);
  assert.equal(b.input(id).state.getSnapshot().draft, a.input(id).state.getSnapshot().draft);
  assert.equal(b.sync.status(id), "草稿已同步");
  passed("native autosave transfers text between independent device stores without sending a model request");

  const held = gate(), started = gate();
  a.save = async (request, signal) => { started.resolve(); await held.promise; return remote("saveDraft", request, signal); };
  a.input(id).setDraft("A 的迟到保存");
  const oldSave = a.sync.flush(id); await started.promise;
  b.sync.receive(id, await b.control(id, true));
  b.input(id).setDraft("设备 B 接续编辑"); await b.sync.flush(id);
  a.sync.receive(id, await a.view(id)); held.resolve(); await oldSave;
  assert.equal((await b.view(id)).draft.text, "设备 B 接续编辑");
  assert.equal(a.input(id).state.getSnapshot().draft, "A 的迟到保存");
  assert.equal(a.sync.status(id), "草稿暂存本机");
  a.save = (request, signal) => remote("saveDraft", request, signal);
  passed("takeover rejects an actual held old-device save while retaining that device's local notes");

  c.input(id, "C 的本机笔记"); c.sync.receive(id, await c.control(id)); c.sync.attach(id);
  const cView = await c.control(id, true); c.sync.receive(id, cView);
  await delay(500);
  assert.equal((await c.view(id)).draft.text, "设备 B 接续编辑");
  assert.equal(c.input(id).state.getSnapshot().draft, "C 的本机笔记");
  c.input(id).setDraft("C 的本机笔记，继续编辑"); await c.sync.flush(id);
  assert.equal((await c.view(id)).draft.text, "C 的本机笔记，继续编辑");
  passed("opening and taking input preserve existing local notes; an explicit edit becomes the new cloud draft");

  let once = true;
  c.save = async (request, signal) => { const result = await remote("saveDraft", request, signal); if (once) { once = false; throw new Error("lost reply"); } return result; };
  c.input(id).setDraft("已保存但回包丢失"); await c.sync.flush(id);
  const lostRevision = (await c.view(id)).draft.revision;
  assert.equal(c.sync.status(id), "草稿暂存本机");
  c.sync.receive(id, await c.view(id)); await c.sync.flush(id);
  assert.equal((await c.view(id)).draft.revision, lostRevision);
  assert.equal(c.sync.status(id), "草稿已同步");
  passed("a real committed save with a lost acknowledgement retains text and retries idempotently");

  c.save = async () => { throw new Error("offline"); };
  c.input(id).setDraft("断网继续写"); await c.sync.flush(id);
  assert.equal(c.input(id).state.getSnapshot().draft, "断网继续写");
  assert.equal((await c.view(id)).draft.text, "已保存但回包丢失");
  c.save = (request, signal) => remote("saveDraft", request, signal);
  c.sync.receive(id, await c.view(id)); await c.sync.flush(id);
  assert.equal((await c.view(id)).draft.text, "断网继续写");
  passed("offline edits stay local and sync after a fresh authenticated cloud view");

  const preSend = gate(), preSendStarted = gate();
  c.save = async (request, signal) => { preSendStarted.resolve(); await preSend.promise; return remote("saveDraft", request, signal); };
  c.input(id).setDraft("迟到的发送前文字");
  const lateSave = c.sync.flush(id); await preSendStarted.promise;
  c.input(id).setDraft(""); c.sync.pause(id);
  const admission = await send(c, id, await c.view(id), "CLIENT-EXPLICIT-SEND");
  assert.equal(admission.result.accepted, true);
  c.sync.receive(id, { ...await c.view(id), draft: admission.draft });
  c.sync.finish(id, true);
  preSend.resolve(); await lateSave;
  assert.equal((await c.view(id)).draft.text, "");
  c.save = (request, signal) => remote("saveDraft", request, signal);
  passed("an admitted message and its inline draft acknowledgement fence a held pre-send autosave");

  c.sync.pause(id);
  const nextAdmission = await send(c, id, await c.view(id), "CLIENT-NEXT-SEND");
  c.input(id).setDraft("等待发送回包时写的下一条");
  c.sync.receive(id, { ...await c.view(id), draft: nextAdmission.draft });
  c.sync.finish(id, true); await c.sync.flush(id);
  assert.equal((await c.view(id)).draft.text, "等待发送回包时写的下一条");
  passed("text typed while prompt admission is pending saves at the acknowledged revision without extra readback RPC");

  c.input(id).setDraft(""); c.sync.pause(id);
  await send(c, id, await c.view(id), "CLIENT-UNCERTAIN-SEND");
  c.sync.finish(id, false);
  c.input(id).setDraft("  CLIENT-UNCERTAIN-SEND  ");
  c.sync.receive(id, await c.view(id)); await c.sync.flush(id);
  assert.equal((await c.view(id)).draft.text, "");
  assert.equal(c.input(id).state.getSnapshot().draft, "  CLIENT-UNCERTAIN-SEND  ");
  c.sync.dispose();
  const reloaded = client(c.storage); reloaded.input(id, "  CLIENT-UNCERTAIN-SEND  ");
  reloaded.sync.receive(id, await reloaded.control(id, true)); reloaded.sync.attach(id); await reloaded.sync.flush(id);
  assert.equal((await reloaded.view(id)).draft.text, "");
  assert.equal(reloaded.input(id).state.getSnapshot().draft, "  CLIENT-UNCERTAIN-SEND  ");
  reloaded.sync.pause(id); reloaded.sync.pause(id);
  reloaded.sync.finish(id, false);
  reloaded.sync.finish(id, false);
  reloaded.input(id).setDraft("本机引用一\n\n本机引用二");
  await reloaded.sync.flush(id);
  assert.equal((await reloaded.view(id)).draft.text, "");
  passed("uncertain admission preserves the actual restored whitespace, references and merged failures locally across reload without republishing them");

  const attachmentSession = await create();
  a.sync.receive(attachmentSession, await a.control(attachmentSession)); a.sync.attach(attachmentSession);
  a.input(attachmentSession).setDraft("带附件的说明"); a.input(attachmentSession).attachments(["local-1", "local-2"]);
  await a.sync.flush(attachmentSession);
  b.sync.receive(attachmentSession, await b.control(attachmentSession, true)); b.sync.attach(attachmentSession);
  assert.equal(b.input(attachmentSession).state.getSnapshot().draft, "");
  assert.equal(b.sync.status(attachmentSession), "草稿含未接续附件");
  assert.equal(b.sync.canRestoreText(attachmentSession), true);
  b.sync.restoreText(attachmentSession); await b.sync.flush(attachmentSession);
  assert.equal(b.input(attachmentSession).state.getSnapshot().draft, "带附件的说明");
  assert.deepEqual(a.input(attachmentSession).state.getSnapshot().attachmentIds, ["local-1", "local-2"]);
  assert.equal((await b.view(attachmentSession)).draft.attachmentCount, 0);
  passed("another device must explicitly resume attachment draft text; original browser attachment ids remain intact");

  const attachmentOnly = await create();
  a.input(attachmentOnly).attachments(["existing-local-attachment"]);
  a.sync.receive(attachmentOnly, await a.control(attachmentOnly)); a.sync.attach(attachmentOnly); await a.sync.flush(attachmentOnly);
  assert.equal((await a.view(attachmentOnly)).draft.attachmentCount, 1);
  b.sync.receive(attachmentOnly, await b.control(attachmentOnly)); b.sync.attach(attachmentOnly);
  assert.equal(b.sync.status(attachmentOnly), "草稿含未接续附件");
  assert.equal(b.sync.canRestoreText(attachmentOnly), false);
  assert.equal(b.input(attachmentSession).state.getSnapshot().draft, "带附件的说明");
  passed("attachment-only drafts retain their source notice and independent sessions keep independent text");

  const closing = gate(), closingStarted = gate();
  reloaded.save = async (request, signal) => { closingStarted.resolve(); await closing.promise; return remote("saveDraft", request, signal); };
  reloaded.sync.edited(id);
  reloaded.input(id).setDraft("关闭时已经开始的保存");
  const closingSave = reloaded.sync.flush(id); await closingStarted.promise;
  reloaded.input(id).setDraft("关闭前最后一次编辑");
  reloaded.sync.dispose();
  const notifications = reloaded.notifications;
  closing.resolve(); await closingSave; await delay(500);
  assert.equal(reloaded.timers.size, 0);
  assert.equal(reloaded.notifications, notifications);
  passed("disposal cancels subscriptions and an in-flight completion cannot recreate timers or UI notifications");

  let definition;
  const cleanup = [], endpoints = [];
  runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { documentElement: { dataset: { remoteDshClient: randomUUID() } }, createElement: () => ({ remove() {} }),
      head: { append() {} }, addEventListener() {}, removeEventListener() {} },
    URL, URLSearchParams, location: { href: config.origin, hash: "", search: "" }, crypto: webcrypto,
    AbortSignal, clearTimeout, setTimeout,
  });
  const plugin = definition.factory(() => ({}));
  const ctx = { effect: (register) => cleanup.push(register()), slots: { inject() {} },
    uiWorkspace: { selection: createSnapshotStore({}), startSession() {} },
    connection: { rpc: { call(channel, endpoint, payload, signal) { endpoints.push(endpoint); return rpc.call(channel, endpoint, payload, signal); } } } };
  try {
    plugin.apply(ctx);
    const sessionId = await create();
    const result = await ctx.connection.rpc.call("/api", "session/prompt", { args: { request: {
      sessionId, requestId: randomUUID(), mode: "queue", content: [{ type: "text", text: "CLIENT-WRAPPED-SEND" }],
    } } });
    assert.equal(result.ok, true);
    assert.equal(result.value.accepted, true);
    assert.deepEqual(Object.keys(result.value), ["accepted"]);
    assert.equal(endpoints.includes("remoteWorkspaces/get"), false);
    passed("the shipped input interceptor returns the native admission result without waiting for a draft readback request");
  } finally { for (const dispose of cleanup.reverse()) dispose?.(); }
  console.log(JSON.stringify({ checks: checks.length, explicitPrompts: 4 }));
} finally {
  for (const value of clients) value.sync.dispose();
}

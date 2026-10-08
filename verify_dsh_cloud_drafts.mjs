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
  let definition, notifications = 0, storageBlocked = false;
  runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { if (storageBlocked) throw new Error("storage full"); storage.set(key, value); }, removeItem: (key) => storage.delete(key) },
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
    select: (request, signal) => remote("selectDraft", { ...request, label: "Draft test device" }, signal),
    currentId: null, blockStorage: (blocked) => { storageBlocked = blocked; },
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
    save: (request, signal) => boundary.save(request, signal), select: (request, signal) => boundary.select(request, signal),
    isCurrent: (id) => boundary.currentId === null || boundary.currentId === id, notify: () => notifications++ });
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
  assert.equal(a.sync.status(id), "本机原稿 · 云端有另一份");
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
  assert.equal(b.sync.canChoose(attachmentSession), true);
  const attachmentPreview = b.sync.preview(attachmentSession);
  await b.sync.selectText(attachmentSession, attachmentPreview, attachmentPreview.draft.text);
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
  assert.equal(b.sync.preview(attachmentOnly).draft.text, "");
  assert.equal(b.input(attachmentSession).state.getSnapshot().draft, "带附件的说明");
  passed("attachment-only drafts retain their source notice and independent sessions keep independent text");

  const choiceId = await create(), d = client(), e = client();
  const original = "  B 的原稿\n@中文目录/文件.txt  ", cloudText = "A 的更新草稿";
  d.input(choiceId, original); d.sync.receive(choiceId, await d.control(choiceId)); d.sync.attach(choiceId); await d.sync.flush(choiceId);
  e.sync.receive(choiceId, await e.control(choiceId, true)); e.sync.attach(choiceId);
  e.input(choiceId).setDraft(cloudText); await e.sync.flush(choiceId);
  d.sync.receive(choiceId, await d.view(choiceId));
  const beforePreview = await d.view(choiceId), preview = d.sync.preview(choiceId);
  assert.equal(d.sync.canChoose(choiceId), true);
  assert.equal(preview.text, original); assert.equal(preview.draft.text, cloudText);
  assert.deepEqual(await d.view(choiceId), beforePreview);
  passed("viewers can preview differing local and cloud drafts without claiming input or mutating either draft");

  const selected = await d.sync.selectText(choiceId, preview, preview.draft.text);
  assert.equal(selected.control.mine, true);
  assert.equal(selected.current.id, beforePreview.current.id);
  assert.equal(selected.revision, beforePreview.revision);
  assert.equal(selected.draft.revision, preview.draft.revision + 1);
  assert.equal(d.input(choiceId).state.getSnapshot().draft, cloudText);
  assert.deepEqual([...d.sync.preview(choiceId).retained], [original]);
  assert.equal(e.input(choiceId).state.getSnapshot().draft, cloudText);
  passed("explicit cloud choice takes input and persists the displaced raw local text before replacing the native editor");

  d.sync.dispose();
  const resumed = client(d.storage); resumed.input(choiceId, cloudText);
  resumed.sync.receive(choiceId, await resumed.control(choiceId)); resumed.sync.attach(choiceId);
  assert.deepEqual([...resumed.sync.preview(choiceId).retained], [original]);
  await resumed.sync.selectText(choiceId, resumed.sync.preview(choiceId), original);
  assert.equal(resumed.input(choiceId).state.getSnapshot().draft, original);
  assert.equal((await resumed.view(choiceId)).draft.text, original);
  assert.deepEqual([...resumed.sync.preview(choiceId).retained], [original, cloudText]);
  const again = client(resumed.storage); again.input(choiceId, original);
  again.sync.receive(choiceId, await again.control(choiceId)); again.sync.attach(choiceId);
  assert.deepEqual([...again.sync.preview(choiceId).retained], [original, cloudText]);
  passed("reload and repeated choices preserve both drafts, including whitespace and raw references, in recoverable window storage");

  const oldDraft = gate(), oldStarted = gate();
  resumed.save = async (request, signal) => { oldStarted.resolve(); await oldDraft.promise; return remote("saveDraft", request, signal); };
  resumed.input(choiceId).setDraft("同一控制窗口的迟到自动保存");
  const sameControllerSave = resumed.sync.flush(choiceId); await oldStarted.promise;
  const choosing = resumed.sync.preview(choiceId);
  await resumed.sync.selectText(choiceId, choosing, choosing.draft.text);
  oldDraft.resolve(); await sameControllerSave;
  assert.equal((await resumed.view(choiceId)).draft.text, original);
  assert.equal(resumed.input(choiceId).state.getSnapshot().draft, original);
  assert.equal((await resumed.view(choiceId)).draft.revision, choosing.draft.revision + 1);
  resumed.save = (request, signal) => remote("saveDraft", request, signal);
  passed("choosing unchanged cloud text fences an actual held autosave from the same controller without relying on an ownership change");

  e.sync.receive(choiceId, await e.control(choiceId, true));
  e.input(choiceId).setDraft("云端预览版本"); await e.sync.flush(choiceId);
  resumed.sync.receive(choiceId, await resumed.view(choiceId));
  const stale = resumed.sync.preview(choiceId);
  e.input(choiceId).setDraft("云端更晚版本"); await e.sync.flush(choiceId);
  await assert.rejects(resumed.sync.selectText(choiceId, stale, stale.draft.text), /云端草稿已更新/);
  assert.equal((await e.view(choiceId)).control.mine, true);
  assert.equal((await resumed.view(choiceId)).control.mine, false);
  assert.equal(resumed.input(choiceId).state.getSnapshot().draft, original);
  passed("a stale preview is rejected by the real Host before taking input or overwriting either device's text");

  resumed.sync.receive(choiceId, await resumed.view(choiceId));
  const beforeEdit = resumed.sync.preview(choiceId), unchanged = await resumed.view(choiceId);
  resumed.input(choiceId).setDraft("预览后新写的本机文字");
  await assert.rejects(resumed.sync.selectText(choiceId, beforeEdit, beforeEdit.draft.text), /输入内容或会话已变化/);
  assert.deepEqual(await resumed.view(choiceId), unchanged);
  passed("local edits after preview invalidate confirmation and leave cloud state and ownership untouched");

  const committed = gate(), reply = gate();
  resumed.select = async (request, signal) => { const result = await remote("selectDraft", request, signal); committed.resolve(); await reply.promise; return result; };
  const pendingPreview = resumed.sync.preview(choiceId);
  const pendingChoice = resumed.sync.selectText(choiceId, pendingPreview, pendingPreview.draft.text);
  await committed.promise;
  resumed.input(choiceId).setDraft("等待选择结果时的新内容");
  reply.resolve(); await assert.rejects(pendingChoice, /输入内容已变化/);
  resumed.sync.receive(choiceId, await resumed.view(choiceId)); await resumed.sync.flush(choiceId);
  assert.equal(resumed.input(choiceId).state.getSnapshot().draft, "等待选择结果时的新内容");
  assert.equal((await resumed.view(choiceId)).draft.text, pendingPreview.draft.text);
  assert.equal(resumed.storage.get(`remote-dsh-uncertain-draft.${choiceId}`), "1");
  passed("a committed selection's late reply cannot overwrite new editor content or republish that content during reconciliation");

  const navigationCommitted = gate(), navigationReply = gate(), otherId = await create();
  resumed.currentId = choiceId;
  resumed.select = async (request, signal) => { const result = await remote("selectDraft", request, signal); navigationCommitted.resolve(); await navigationReply.promise; return result; };
  resumed.input(otherId, "另一个会话的原稿");
  const navigationPreview = resumed.sync.preview(choiceId);
  const navigationChoice = resumed.sync.selectText(choiceId, navigationPreview, navigationPreview.draft.text);
  await navigationCommitted.promise; resumed.currentId = otherId; navigationReply.resolve();
  await assert.rejects(navigationChoice, /会话或输入内容已变化/);
  assert.equal(resumed.input(choiceId).state.getSnapshot().draft, "等待选择结果时的新内容");
  assert.equal(resumed.input(otherId).state.getSnapshot().draft, "另一个会话的原稿");
  resumed.currentId = choiceId;
  passed("navigating to another session while a real selection commits preserves both editors when the reply arrives");

  const fullId = await create(), f = client(), g = client();
  f.input(fullId, "存储不足时的原稿"); f.sync.receive(fullId, await f.control(fullId)); f.sync.attach(fullId); await f.sync.flush(fullId);
  g.sync.receive(fullId, await g.control(fullId, true)); g.sync.attach(fullId);
  g.input(fullId).setDraft("待接续的远端稿"); await g.sync.flush(fullId);
  f.sync.receive(fullId, await f.view(fullId));
  const fullPreview = f.sync.preview(fullId), fullBefore = await f.view(fullId);
  f.blockStorage(true);
  await assert.rejects(f.sync.selectText(fullId, fullPreview, fullPreview.draft.text), /无法保存本机原稿/);
  assert.equal(f.input(fullId).state.getSnapshot().draft, "存储不足时的原稿");
  assert.deepEqual(await f.view(fullId), fullBefore);
  assert.equal(f.storage.has(`remote-dsh-retained-drafts.${fullId}`), false);
  f.blockStorage(false);
  passed("browser storage failure prevents the actual replacement and takeover while preserving the original editor and cloud state");

  f.input(fullId).attachments(["local-attachment"]);
  const localAttachmentPreview = f.sync.preview(fullId);
  await assert.rejects(f.sync.selectText(fullId, localAttachmentPreview, localAttachmentPreview.draft.text), /当前输入框含附件/);
  assert.deepEqual(f.input(fullId).state.getSnapshot().attachmentIds, ["local-attachment"]);
  assert.deepEqual(await f.view(fullId), fullBefore);
  f.input(fullId).attachments([]);
  passed("an editor with local attachments cannot be replaced by another draft and retains its real attachment identities");

  f.select = async (request, signal) => { await remote("selectDraft", request, signal); throw new Error("selection reply lost"); };
  const lostChoicePreview = f.sync.preview(fullId);
  await assert.rejects(f.sync.selectText(fullId, lostChoicePreview, lostChoicePreview.draft.text), /reply lost/);
  f.sync.receive(fullId, await f.view(fullId)); await f.sync.flush(fullId);
  assert.equal(f.input(fullId).state.getSnapshot().draft, "存储不足时的原稿");
  assert.equal((await f.view(fullId)).draft.text, "待接续的远端稿");
  const afterLoss = client(f.storage); afterLoss.input(fullId, "存储不足时的原稿");
  afterLoss.sync.receive(fullId, await afterLoss.control(fullId, true)); afterLoss.sync.attach(fullId); await afterLoss.sync.flush(fullId);
  assert.equal((await afterLoss.view(fullId)).draft.text, "待接续的远端稿");
  await afterLoss.sync.selectText(fullId, afterLoss.sync.preview(fullId), "待接续的远端稿");
  assert.equal(afterLoss.storage.has(`remote-dsh-uncertain-draft.${fullId}`), false);
  assert.equal(afterLoss.input(fullId).state.getSnapshot().draft, "待接续的远端稿");
  passed("a selection with a lost acknowledgement retains the original through reload and reconnect until explicit retry reconciles it");

  const raceView = await afterLoss.view(fullId);
  const racePayload = { sessionId: fullId, clientId: afterLoss.clientId, epoch: raceView.control.epoch, revision: raceView.draft.revision };
  const racers = await Promise.allSettled(["选择一", "选择二"].map((text) => remote("selectDraft", { ...racePayload, text })));
  assert.equal(racers.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(racers.filter((item) => item.status === "rejected").length, 1);
  const winner = racers.find((item) => item.status === "fulfilled").value;
  assert.deepEqual((await afterLoss.view(fullId)).draft, winner.draft);
  assert.equal(winner.draft.revision, raceView.draft.revision + 1);
  passed("concurrent authenticated confirmations accept one version and reject the other without overwriting the winner");

  afterLoss.sync.receive(fullId, await afterLoss.view(fullId));
  afterLoss.input(fullId).setDraft("取消接续时的本机原稿");
  const cancelledPreview = afterLoss.sync.preview(fullId), cancelCommitted = gate(), cancelReply = gate(), cancellation = new AbortController();
  afterLoss.select = async (request, signal) => { const result = await remote("selectDraft", request, signal); cancelCommitted.resolve(); await cancelReply.promise; return result; };
  const cancelChoice = afterLoss.sync.selectText(fullId, cancelledPreview, cancelledPreview.draft.text, cancellation.signal);
  await cancelCommitted.promise; cancellation.abort(); cancelReply.resolve();
  await assert.rejects(cancelChoice, /abort/i);
  afterLoss.sync.receive(fullId, await afterLoss.view(fullId)); await afterLoss.sync.flush(fullId);
  assert.equal(afterLoss.input(fullId).state.getSnapshot().draft, "取消接续时的本机原稿");
  assert.equal((await afterLoss.view(fullId)).draft.text, cancelledPreview.draft.text);
  passed("cancelling a committed selection before its acknowledgement retains local text and reconciles cloud state without an automatic overwrite");

  const emptyId = await create(), empty = client(), emptyCommitted = gate(), emptyReply = gate(), emptyAbort = new AbortController();
  e.sync.receive(emptyId, await e.control(emptyId)); e.sync.attach(emptyId);
  e.input(emptyId).setDraft("空编辑器待接续的文字"); e.input(emptyId).attachments(["source-attachment"]); await e.sync.flush(emptyId);
  empty.sync.receive(emptyId, await empty.control(emptyId)); empty.sync.attach(emptyId);
  assert.equal(empty.input(emptyId).state.getSnapshot().draft, "");
  empty.select = async (request, signal) => { const result = await remote("selectDraft", request, signal); emptyCommitted.resolve(); await emptyReply.promise; return result; };
  const emptyPreview = empty.sync.preview(emptyId);
  const emptySelection = empty.sync.selectText(emptyId, emptyPreview, emptyPreview.draft.text, emptyAbort.signal);
  await emptyCommitted.promise; emptyAbort.abort(); emptyReply.resolve(); await assert.rejects(emptySelection, /abort/i);
  empty.sync.receive(emptyId, await empty.view(emptyId));
  assert.equal(empty.input(emptyId).state.getSnapshot().draft, "");
  const emptyReload = client(empty.storage);
  emptyReload.sync.receive(emptyId, await emptyReload.control(emptyId)); emptyReload.sync.attach(emptyId);
  assert.equal(emptyReload.input(emptyId).state.getSnapshot().draft, "");
  assert.equal((await emptyReload.view(emptyId)).draft.text, emptyPreview.draft.text);
  assert.deepEqual(e.input(emptyId).state.getSnapshot().attachmentIds, ["source-attachment"]);
  passed("cancelled text-only selection keeps an originally empty editor empty through cloud refresh and reload");

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

/** Exercise the patched DSH factory with its actual native store engine. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { remoteConversationStore } from "./dsh-product/remote-drafts.mjs";

const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const { defineStore, createSnapshotStore } = await import(require.resolve("@deepseek-ai/dsh-client-store"));
const clientSource = await readFile(new URL("./dsh-product/plugin/client.js", import.meta.url), "utf8");
const source = await readFile(require.resolve("@deepseek-ai/dsh-client-ui-conversation/package.json").replace("package.json", "lib/client.js"), "utf8");
assert.ok(source.includes(remoteConversationStore.toString()), "Run node dsh-product/patch-dsh.mjs before verification");
const start = source.indexOf('const CONVERSATION_STORE_KEY = "dsh.conversation";');
const end = source.indexOf("\t\t/**\n\t\t* Read the persisted View preference", start);
assert.ok(start > 0 && end > start);
const factory = source.slice(start, end) + "\ncreateConversationStore(sessions);";

class Storage {
  values = new Map();
  fail = false;
  getItem(key) { if (this.fail) throw new Error("Storage unavailable"); return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.fail) throw new Error("Storage unavailable"); this.values.set(key, value); }
  removeItem(key) { if (this.fail) throw new Error("Storage unavailable"); this.values.delete(key); }
}

const shared = new Storage();
let controller = "window-a";
const sessions = { binding() { return { session: { projections: { faceOf() { return { getSnapshot() { return controller ? { clientId: controller } : null; } }; } } } }; } };
globalThis.localStorage = shared;
const windowStore = (clientId, storage = new Storage()) => {
  const ctx = {
    _deepseek_ai_dsh_client_store: { defineStore }, sessions,
    document: { documentElement: { dataset: { ...(clientId ? { remoteDshClient: clientId } : {}) } } },
    localStorage: shared, sessionStorage: storage,
  };
  const handle = runInNewContext(factory, ctx);
  return { storage, create: (sessionId) => handle.create(sessionId) };
};
const latest = (sessionId = "session-1") => JSON.parse(shared.getItem(`dsh.conversation.${sessionId}`));
const selectionInWindow = (storage) => {
  let definition;
  runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { documentElement: { dataset: {} }, createElement() { return { remove() {} }; }, head: { append() {} } },
    sessionStorage: storage, performance: { getEntriesByType() { return [{ type: "reload" }]; } },
    URL, URLSearchParams, location: { hash: "", search: "", href: "http://127.0.0.1:1" },
    crypto: { randomUUID }, setTimeout, clearTimeout,
  });
  const plugin = definition.factory((name) => {
    if (["react", "@deepseek-ai/dsh-client-ui-primitives"].includes(name)) return {};
    throw new Error(`Unexpected dependency: ${name}`);
  });
  const disposers = [];
  const selection = createSnapshotStore({}, { persist: { name: "dsh.sessions.current" } });
  plugin.apply({
    connection: { rpc: { call() { throw new Error("Selection recovery must not make a cloud request"); } } },
    uiWorkspace: { selection, startSession() {} }, slots: { inject() {} },
    effect(register) { disposers.push(register()); },
  });
  return { selection, dispose() { for (const dispose of disposers.reverse()) dispose?.(); } };
};
let checks = 0;
const passed = (name) => { checks++; console.log("PASS " + name); };

try {
  shared.setItem("dsh.conversation.session-1", JSON.stringify({ draft: "旧版草稿", view: "chat", viewRequest: null }));
  const a = windowStore("window-a"), b = windowStore("window-b");
  let aa = a.create("session-1"), bb = b.create("session-1");
  assert.equal(aa.getSnapshot().draft, "旧版草稿");
  assert.equal(bb.getSnapshot().draft, "旧版草稿");
  assert.equal(latest().draft, "旧版草稿");
  passed("existing browser drafts recover without rewriting the shared record");

  aa.actions.setDraft("A 尚未发送\n中文 project\n");
  bb.actions.setView("trajectory");
  assert.equal(latest().draft, "A 尚未发送\n中文 project\n");
  assert.equal(a.create("session-1").getSnapshot().draft, "A 尚未发送\n中文 project\n");
  passed("a viewer changing views does not overwrite the current controller's draft");

  controller = "window-b";
  bb.actions.setDraft("B 独立内容");
  aa = a.create("session-1");
  assert.equal(aa.getSnapshot().draft, "A 尚未发送\n中文 project\n");
  assert.equal(b.create("session-1").getSnapshot().draft, "B 独立内容");
  assert.equal(latest().draft, "B 独立内容");
  passed("handoff and reload preserve each tab's draft and the latest shared recovery");

  bb.actions.setDraft("");
  assert.equal(a.create("session-1").getSnapshot().draft, "A 尚未发送\n中文 project\n");
  assert.equal(b.create("session-1").getSnapshot().draft, "");
  assert.equal(windowStore("window-c").create("session-1").getSnapshot().draft, "");
  passed("sending or clearing in one tab keeps the other tab's unsent text and its own empty state");

  aa.actions.setDraft("A failed submission restored");
  aa.actions.setView("chat");
  assert.equal(latest().draft, "");
  assert.equal(a.create("session-1").getSnapshot().draft, "A failed submission restored");
  passed("a late restore after losing input cannot replace the new controller's shared draft");

  controller = "window-a";
  const other = a.create("session-2");
  other.actions.setDraft("另一个项目");
  assert.equal(a.create("session-1").getSnapshot().draft, "A failed submission restored");
  assert.equal(a.create("session-2").getSnapshot().draft, "另一个项目");
  other.clearPersisted();
  assert.equal(a.create("session-2").getSnapshot().draft, "");
  assert.equal(a.create("session-1").getSnapshot().draft, "A failed submission restored");
  passed("switching projects and clearing one stored session keep unrelated drafts");

  const brokenOwn = new Storage();
  brokenOwn.fail = true;
  const fallback = windowStore("window-a", brokenOwn).create("session-3");
  fallback.actions.setDraft("shared recovery works");
  assert.equal(windowStore("window-a", brokenOwn).create("session-3").getSnapshot().draft, "shared recovery works");
  const cached = a.create("session-4");
  shared.fail = true;
  cached.actions.setDraft("window recovery works");
  assert.equal(a.create("session-4").getSnapshot().draft, "window recovery works");
  shared.fail = false;
  passed("storage failures retain editing and whichever recovery store is available");

  shared.setItem("dsh.conversation.session-5", "{broken");
  a.storage.setItem("remote-dsh-window.dsh.conversation.session-5", JSON.stringify({ draft: null, view: "chat" }));
  assert.equal(a.create("session-5").getSnapshot().draft, "");
  shared.setItem("dsh.conversation.session-5", JSON.stringify({ draft: "valid shared", view: "chat", viewRequest: null }));
  assert.equal(a.create("session-5").getSnapshot().draft, "");
  a.storage.removeItem("remote-dsh-window.dsh.conversation.session-5");
  assert.equal(a.create("session-5").getSnapshot().draft, "valid shared");
  passed("corrupt snapshots recover safely and an explicit empty tab draft stays empty");

  const ordinary = windowStore(null);
  ordinary.create("ordinary").actions.setDraft("local DSH");
  assert.equal(ordinary.create("ordinary").getSnapshot().draft, "local DSH");
  assert.equal(ordinary.storage.values.size, 0);
  passed("ordinary DSH continues using its native shared persistence");

  const windowA = new Storage(), windowB = new Storage();
  let selectedA = selectionInWindow(windowA), selectedB = selectionInWindow(windowB);
  selectedA.selection.set({ sessionId: "project-a" });
  selectedB.selection.set({ sessionId: "project-b" });
  selectedA.dispose(); selectedB.dispose();
  selectedA = selectionInWindow(windowA);
  selectedB = selectionInWindow(windowB);
  assert.equal(selectedA.selection.getSnapshot().sessionId, "project-a");
  assert.equal(selectedB.selection.getSnapshot().sessionId, "project-b");
  selectedA.dispose(); selectedB.dispose();
  passed("the actual plugin restores each tab's selected project after another tab navigates");

  const fresh = selectionInWindow(new Storage());
  assert.equal(fresh.selection.getSnapshot().sessionId, "project-b");
  fresh.dispose();
  const invalid = new Storage();
  invalid.setItem("remote-dsh-window-selection", JSON.stringify({ sessionId: 42 }));
  const recovered = selectionInWindow(invalid);
  assert.equal(recovered.selection.getSnapshot().sessionId, "project-b");
  recovered.dispose();
  passed("fresh tabs and invalid window selections use the native browser recovery");

  windowA.setItem("remote-dsh-window-selection", JSON.stringify({}));
  const cleared = selectionInWindow(windowA);
  assert.equal(Object.keys(cleared.selection.getSnapshot()).length, 0);
  cleared.dispose();
  passed("a deliberately cleared tab selection does not adopt another tab's project");

  const unavailable = new Storage();
  unavailable.fail = true;
  const usable = selectionInWindow(unavailable);
  usable.selection.set({ sessionId: "working-without-window-storage" });
  assert.equal(usable.selection.getSnapshot().sessionId, "working-without-window-storage");
  usable.dispose();
  passed("window storage failure keeps native conversation navigation usable");
  console.log(JSON.stringify({ checks, passed: true }));
} finally {
  delete globalThis.localStorage;
}

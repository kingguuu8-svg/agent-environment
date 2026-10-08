/** Exercise preparation, cancellation and recovery through the actual plugin's UI slots. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const React = require("react"), { act, create } = require("react-test-renderer");
const { createSnapshotStore } = await import(require.resolve("@deepseek-ai/dsh-client-store"));
const source = await readFile(new URL("./dsh-product/plugin/client.js", import.meta.url), "utf8");
const a = { id: "cloud", machine: "cloud", hostname: "A", workspace: "/fixture/project A" };
const b = { id: "target-b", machine: "laptop", hostname: "B", workspace: "/fixture/project B" };
let checks = 0;
const passed = (name) => { checks++; console.log("PASS " + name); };

async function fixture(mine = false) {
  let root, Header, Overlay, plugin, failure, activeSession = "session-a";
  let view = { current: a, pending: null, revision: 0, control: { mine, epoch: "initial-epoch", label: "Original window" }, connection: { status: "online" } };
  const cleanup = [], requests = [], pending = [], listeners = new Set();
  const selection = createSnapshotStore({ sessionId: activeSession });
  const Modal = ({ children, title }) => React.createElement("section", { "data-modal": title }, children);
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(definition) { plugin = definition.factory((name) => name === "react" ? React : { Modal }); } } },
    document: { visibilityState: "visible", documentElement: { dataset: {} }, createElement: () => ({ remove() {} }), head: { append() {} },
      addEventListener(name, listener) { if (name === "visibilitychange") listeners.add(listener); }, removeEventListener(_name, listener) { listeners.delete(listener); } },
    sessionStorage: { getItem: () => null, setItem() {} }, performance: { getEntriesByType: () => [] },
    location: { hash: "", search: "", href: "http://127.0.0.1:1" }, URL, URLSearchParams, crypto: { randomUUID }, AbortController, AbortSignal,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  plugin.apply({
    connection: { rpc: { async call(channel, endpoint, payload, signal) {
      assert.equal(channel, "/api");
      const method = endpoint.split("/")[1], request = payload.args.request;
      requests.push({ method, request, signal });
      if (method === "get") { if (failure) throw failure; return { ok: true, value: view }; }
      if (method === "control") return { ok: true, value: view };
      if (method === "probe") return { ok: true, value: { status: "online" } };
      if (method === "catalog") return { ok: true, value: { machines: [a, b].map((value) => ({ ...value, id: value.machine, label: value.hostname })), savedWorkspaces: [a, b], tools: ["read", "bash"] } };
      if (method === "browse") return { ok: true, value: { absolutePath: request.path || (request.machine === "cloud" ? a : b).workspace, home: "/fixture", entries: [] } };
      if (method === "switch") return new Promise((resolve, reject) => {
        const entry = { request, signal, resolve: (value = view) => resolve({ ok: true, value }), reject };
        pending.push(entry);
        entry.cancel = () => reject(signal.reason);
        signal?.addEventListener("abort", entry.cancel, { once: true });
      });
      if (method === "pick") return new Promise((resolve) => { pending.push({ resolve }); });
      throw new Error("Unexpected RPC " + endpoint);
    } } },
    sessions: { scope: () => null }, inputTriggers: {},
    uiWorkspace: { selection, startSession() {} },
    sidebarRight: { isExpanded: () => false, tabsIn: () => [], closeIn() {}, openTab() {} },
    slots: { inject(name, register) { if (["conversation.session.header.utilities", "shell.overlay"].includes(name)) register(); },
      register(options, component) { if (options.id === "remote-workspace") Header = component; if (options.id === "remote-new-session") Overlay = component; return () => {}; } },
    effect(register) { cleanup.push(register()); },
  });
  const render = () => React.createElement(React.Fragment, null,
    React.createElement(Header, { sessionId: activeSession, useProjection: () => ({ current: a, pending: null, revision: 0 }) }), React.createElement(Overlay));
  const settle = async (operation = () => {}) => act(async () => { await operation(); await new Promise((resolve) => setImmediate(resolve)); });
  await settle(() => { root = create(render()); });
  const button = (name) => root.root.findAllByType("button").find((entry) => entry.props["aria-label"] === name || entry.children.join("") === name);
  const text = () => JSON.stringify(root.toJSON());
  const choose = async () => {
    await settle(() => { root.root.findByProps({ className: "rw-button rw-target" }).props.onClick(); });
    await settle(() => { button("B · B").props.onClick(); });
  };
  const prepare = async () => {
    let completion;
    await settle(() => { completion = button(mine ? "切换到此工作区" : "接管并切换").props.onClick(); });
    return { completion, entry: pending.at(-1) };
  };
  return { button, choose, prepare, settle, text, requests, pending,
    target: () => root.root.findByProps({ className: "rw-bar" }).props["data-remote-machine"],
    isOpen: () => root.root.findAllByType(Modal).length > 0,
    dismiss: () => root.root.findByType(Modal).props.onClose(),
    setView(value) { view = { ...view, ...value }; },
    setFailure(value) { failure = value; },
    async refresh() { await settle(() => { for (const listener of listeners) listener(); }); },
    async changeSession() { activeSession = "session-other"; selection.set({ sessionId: activeSession }); await settle(() => root.update(render())); },
    async close() { await settle(() => root.unmount()); for (const dispose of cleanup.reverse()) dispose?.(); },
  };
}

let f = await fixture();
try {
  await f.choose();
  const { completion, entry } = await f.prepare();
  assert.equal(entry.request.takeover, true);
  assert.equal(f.button("取消准备").props.disabled, false);
  assert.equal(f.button("关闭").props.disabled, false);
  assert.equal(f.button("B · B").props.disabled, true);
  assert.match(f.text(), /正在连接并检查目标工作区/);
  await f.settle(() => { f.button("取消准备").props.onClick(); });
  await completion;
  assert.equal(entry.signal.aborted, true);
  assert.equal(f.isOpen(), false); assert.equal(f.target(), "cloud");
  assert.match(f.text(), /已取消工作区准备/); assert.match(f.text(), /查看模式/);
  assert.equal(f.requests.filter((request) => request.method === "switch").length, 1);
  passed("a viewer can cancel slow handoff preparation and keeps the original workspace and viewing mode");

  await f.choose();
  const retry = await f.prepare();
  f.setView({ current: b, revision: 1, control: { mine: true, epoch: "new-epoch" } });
  await f.settle(() => { retry.entry.resolve(); }); await retry.completion;
  assert.equal(f.isOpen(), false); assert.equal(f.target(), "laptop");
  assert.match(f.text(), /已接管输入并切换/);
  passed("an explicit retry uses a fresh request and successfully continues on the new workspace");
} finally { await f.close(); }

for (const dismiss of ["关闭", "modal"]) {
  f = await fixture(true);
  try {
    await f.choose(); const { completion, entry } = await f.prepare();
    const control = f.requests.findLast((request) => request.method === "control");
    assert.equal(control.signal, entry.signal);
    assert.equal(entry.request.epoch, "initial-epoch");
    await f.settle(() => { if (dismiss === "modal") f.dismiss(); else f.button(dismiss).props.onClick(); });
    await completion;
    assert.equal(entry.signal.aborted, true); assert.equal(f.target(), "cloud");
    assert.match(f.text(), /云端记录 · 可输入/); assert.equal(f.isOpen(), false);
    passed((dismiss === "modal" ? "modal dismissal" : "the close button") + " cancels an owned switch through the same signal while retaining input");
  } finally { await f.close(); }
}

for (const queued of [false, true]) {
  f = await fixture();
  try {
    await f.choose(); const { completion } = await f.prepare();
    f.setView({ current: queued ? a : b, pending: queued ? b : null, revision: 1, control: { mine: true } });
    await f.settle(() => { f.button("取消准备").props.onClick(); }); await completion;
    assert.match(f.text(), /已停止等待/); assert.doesNotMatch(f.text(), /已取消工作区准备/);
    assert.equal(f.target(), queued ? "cloud" : "laptop");
    if (queued) assert.match(f.text(), /任务结束后切换至 B/);
    assert.equal(f.requests.filter((request) => request.method === "switch").length, 1);
    passed("a " + (queued ? "queued" : "completed") + " switch with a lost response is reconciled from the cloud without rollback or replay");
  } finally { await f.close(); }
}

f = await fixture();
try {
  await f.choose(); const { completion, entry } = await f.prepare();
  entry.signal.removeEventListener("abort", entry.cancel);
  await f.settle(() => { f.button("取消准备").props.onClick(); });
  await f.choose(); assert.equal(f.isOpen(), true);
  await f.settle(() => { entry.resolve({ current: b, revision: 1, control: { mine: true } }); }); await completion;
  assert.equal(f.target(), "cloud"); assert.equal(f.isOpen(), true);
  passed("a response arriving after cancellation cannot apply stale state or close a newly opened workspace picker");
} finally { await f.close(); }

f = await fixture();
try {
  await f.choose(); const { completion } = await f.prepare();
  f.setFailure(new Error("HTTP 503"));
  await f.settle(() => { f.button("取消准备").props.onClick(); }); await completion;
  assert.equal(f.isOpen(), false); assert.match(f.text(), /云端结果暂未确认/);
  assert.doesNotMatch(f.text(), /已取消工作区准备/);
  f.setFailure(null); await f.refresh();
  assert.equal(f.target(), "cloud"); assert.match(f.text(), /已连接/);
  assert.equal(f.requests.filter((request) => request.method === "switch").length, 1);
  passed("lost cloud confirmation remains uncertain, recovers through normal refresh and never resubmits the switch");
} finally { await f.close(); }

f = await fixture();
try {
  await f.choose(); const { completion, entry } = await f.prepare();
  entry.signal.removeEventListener("abort", entry.cancel);
  await f.changeSession();
  assert.equal(entry.signal.aborted, true);
  await f.settle(() => { entry.resolve({ current: b, revision: 1, control: { mine: true } }); }); await completion;
  assert.equal(f.target(), "cloud"); assert.doesNotMatch(f.text(), /已接管输入|已取消工作区准备/);
  passed("selecting another conversation cancels the old preparation and late results cannot alter its target or notices");
} finally { await f.close(); }
console.log(JSON.stringify({ checks, passed: true }));

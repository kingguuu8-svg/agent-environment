/** Render actual DSH edit rows with persisted results from the SSH integration. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const React = require("react");
const { act, create } = require("react-test-renderer");
const { SlotCore } = await import(require.resolve("@deepseek-ai/dsh-client-ui-slots"));
const { createSnapshotStore } = await import(require.resolve("@deepseek-ai/dsh-client-store"));
const rendererSource = await readFile(require.resolve("@deepseek-ai/dsh-client-ui-renderer/package.json").replace("package.json", "lib/client.js"), "utf8");
const nativeSource = await readFile(require.resolve("@deepseek-ai/dsh-client-ui-tool/package.json").replace("package.json", "lib/client.js"), "utf8");
const clientSource = await readFile(process.argv[2] ?? new URL("./dsh-product/plugin/client.js", import.meta.url), "utf8");
const report = JSON.parse(await readFile(new URL("./.local/verification-dsh-pi-results.json", import.meta.url), "utf8"));
const anchor = "exports.apply = apply;";
assert.equal(nativeSource.split(anchor).length, 2);
// Only chrome primitives are substituted; the row, result derivation, React
// rendering and registry are the pinned upstream implementations.
const primitives = new Proxy({
  TextShimmer: ({ children }) => React.createElement("span", null, children),
  DisclosureRow: ({ title, open, collapsedContent, children }) => React.createElement("section", null,
    React.createElement("span", null, title), collapsedContent, open ? children : null),
}, { get(target, key) {
  if (key in target) return target[key];
  if (String(key).startsWith("Icon")) return () => null;
  throw new Error(`Unexpected native primitive ${String(key)}`);
} });
let NativeEdit;
runInNewContext(nativeSource.replace(anchor, `${anchor}\nexports.test = { FileMutationRow };`), {
  window: { __ModuleLoader__: { load(definition) {
    NativeEdit = definition.factory((name) => {
      if (name === "react" || name === "react/jsx-runtime") return require(name);
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
      throw new Error(`Unexpected native dependency ${name}`);
    }).test.FileMutationRow;
  } } }, TextEncoder, TextDecoder,
});
let bindSnapshotSelector;
runInNewContext(rendererSource.replace(anchor, `${anchor}\nexports.test = { bindSnapshotSelector };`), {
  window: { __ModuleLoader__: { load(definition) {
    bindSnapshotSelector = definition.factory((name) => name.startsWith("react-dom") ? {} : require(name)).test.bindSnapshotSelector;
  } } }, console,
});

function fixture(late = false, history = null) {
  const slots = new SlotCore(), cleanup = [];
  const factoryDispose = slots.registerFactory({ name: "test-tool", scope: "root", children: {
    "tool.call.toolview": { kind: "keyed", scope: "session" },
  } }, () => null);
  let disposeNative, plugin;
  const registerNative = () => { disposeNative = slots.register({ name: "tool.call.toolview", key: "edit", locale: "native-edit" }, NativeEdit); };
  if (!late) registerNative();
  runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(definition) { plugin = definition.factory((name) => {
      if (name === "react") return React;
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
      throw new Error(`Unexpected plugin dependency ${name}`);
    }); } } },
    document: { documentElement: { dataset: {} }, createElement: () => ({ remove() {} }), head: { append() {} }, addEventListener() {}, removeEventListener() {} },
    sessionStorage: { getItem: () => null, setItem() {} }, performance: { getEntriesByType: () => [] },
    location: { hash: "", search: "", href: "http://127.0.0.1:1" }, URL, URLSearchParams, crypto: { randomUUID },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  plugin.apply({
    slots: { register: slots.register.bind(slots), entriesOfSlot: slots.entriesOfSlot.bind(slots), subscribe: slots.subscribe.bind(slots),
      inject(name, register) { if (name === "tool.call.toolview") cleanup.push(register()); } },
    connection: { rpc: { call: history?.rpc ?? (() => { throw new Error("Rendering cannot make an RPC request"); }) } },
    uiWorkspace: { selection: history?.selection ?? createSnapshotStore({}), startSession() {} },
    sessions: history ? { binding(sessionId) {
      assert.equal(sessionId, history.sessionId);
      return { session: { projections: { faceOf(key) { assert.equal(key, "remoteBinding"); return history.projection; } } } };
    } } : undefined,
    sidebarRight: history?.sidebarRight,
    effect(register) { cleanup.push(register()); },
  });
  return {
    registerNative, entry: () => slots.entriesOfSlot("tool.call.toolview").find((entry) => entry.options.key === "edit"),
    disposePlugin() { for (const dispose of cleanup.splice(0).reverse()) dispose?.(); },
    close() { this.disposePlugin(); disposeNative?.(); factoryDispose(); },
  };
}

const actual = { kind: "tool", callId: report.toolCalls[0].callId,
  call: { name: "edit", argsRaw: report.toolCalls[0].arguments },
  content: report.editResult.message.content, isError: false, meta: report.editResult.meta };
const original = JSON.stringify(actual);
const props = { toolName: "edit", block: actual, phase: "result", cwd: "/remote/project", home: "/remote",
  useDisclosure: () => ({ expanded: true, toggle() {} }), t: (key) => key };
let checks = 0;
const passed = (name) => { checks++; console.log("PASS " + name); };
const render = async (component, overrides = {}) => {
  let root;
  await act(async () => { root = create(React.createElement(component, { ...props, ...overrides })); });
  try { return root.toJSON(); } finally { await act(async () => root.unmount()); }
};
const textOf = (node) => typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join("") : node?.children?.map(textOf).join("") ?? "";
const test = fixture();
try {
  const view = test.entry().component;
  assert.equal(test.entry().locale, "native-edit");
  const text = textOf(await render(view));
  assert.ok(text.includes(report.editResult.message.content[0].text));
  assert.ok(text.includes("修改差异：\n-1 BEFORE\n+1 AFTER"));
  assert.equal(JSON.stringify(actual), original);
  passed("an actual SSH edit renders its exact applied diff and original output without mutating the persisted model message");

  const old = { ...actual }; delete old.meta;
  const failed = { ...actual, ...report.failedResult.message, meta: actual.meta };
  for (const block of [old, failed, { ...actual, meta: { remotePi: { diff: 4 } } }]) {
    assert.deepEqual(await render(view, { block }), await render(NativeEdit, { block }));
  }
  passed("old records, failed edits and invalid metadata retain the exact native presentation");

  const preparing = { phase: "preparing" }, running = { phase: "start", name: "edit", argsRaw: actual.call.argsRaw };
  for (const [phase, block] of [["preparing", preparing], ["start", running]]) {
    const options = { phase, block, useToolCallArgumentsPartial: () => '{"path":' };
    assert.deepEqual(await render(view, options), await render(NativeEdit, options));
  }
  passed("preparing and running calls keep the upstream lifecycle display without inventing an applied diff");

  const hostile = { ...actual, meta: { remotePi: { diff: '-1 <script>alert("diff")</script>\n+1 &safe' } } };
  const escaped = await render(view, { block: hostile });
  assert.ok(textOf(escaped).includes(hostile.meta.remotePi.diff));
  const checkTextOnly = (node) => {
    if (Array.isArray(node)) return node.forEach(checkTextOnly);
    if (node === null || typeof node === "string") return;
    assert.notEqual(node.type, "script");
    assert.equal(node.props.dangerouslySetInnerHTML, undefined);
    node.children?.forEach(checkTextOnly);
  };
  checkTextOnly(escaped);
  passed("HTML-like file contents remain literal React text nodes");

  let root, opened;
  await act(async () => { root = create(React.createElement(view, { ...props, openFile(path) { opened = path; } })); });
  try {
    const fileButton = root.root.findAllByType("button").find((item) => item.props.onKeyDown);
    assert.ok(fileButton);
    await act(async () => fileButton.props.onClick({ stopPropagation() {} }));
    assert.equal(opened, "说明 空格.txt");
  } finally { await act(async () => root.unmount()); }
  passed("the actual native file button still opens the original Unicode filename");

  test.disposePlugin();
  assert.equal(test.entry().component, NativeEdit);
  assert.deepEqual(await render(test.entry().component), await render(NativeEdit));
  passed("plugin teardown restores the original native slot and row");
} finally { test.close(); }

const late = fixture(true);
try {
  assert.equal(late.entry(), undefined);
  late.registerNative();
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(late.entry().component, NativeEdit);
  assert.ok(textOf(await render(late.entry().component)).includes("修改差异：\n-1 BEFORE\n+1 AFTER"));
  late.disposePlugin();
  assert.equal(late.entry().component, NativeEdit);
  passed("late native registration receives the same wrapper and teardown preserves native ownership");
} finally { late.close(); }

const sessionId = "session-history", origin = actual.meta.remotePi.origin;
assert.ok(origin);
const current = { id: "other-project", machine: "laptop", workspace: "/remote/other" };
const projection = createSnapshotStore({ current, pending: null, revision: 1 });
const selection = createSnapshotStore({ sessionId });
let reply, rejectReply;
const opened = [], requests = [];
const history = fixture(false, { sessionId, projection, selection,
  rpc(channel, endpoint, payload) {
    assert.equal(channel, "/api"); assert.equal(endpoint, "remoteWorkspaces/toolOrigin");
    requests.push(payload.args.request);
    return new Promise((resolve, reject) => { reply = resolve; rejectReply = reject; });
  },
  sidebarRight: { openResource(address, options) { opened.push({ address, options }); } },
});
let historyRoot;
try {
  const entry = history.entry(), injected = entry.inject(sessionId);
  assert.equal(injected.historySessionId, sessionId);
  const useToolBinding = bindSnapshotSelector(injected.hooks.toolBinding);
  await act(async () => { historyRoot = create(React.createElement(entry.component, {
    ...props, callId: actual.callId, historySessionId: injected.historySessionId, useToolBinding,
  })); });
  assert.ok(textOf(historyRoot.toJSON()).includes("执行于 "));
  await act(async () => projection.set({ current: origin, pending: current, revision: 2 }));
  assert.ok(!textOf(historyRoot.toJSON()).includes("执行于 "));
  await act(async () => projection.set({ current, pending: null, revision: 3 }));
  assert.ok(textOf(historyRoot.toJSON()).includes("执行于 "));
  passed("the actual injected selector follows the owning session and distinguishes current from pending workspaces");

  const button = () => historyRoot.root.findAllByType("button").find((item) => item.props.onKeyDown);
  const scopeId = "remote-tool-file:" + JSON.stringify([sessionId, actual.callId]);
  let pending;
  await act(async () => { pending = button().props.onClick({ stopPropagation() {} }); });
  assert.equal(opened.length, 0);
  await act(async () => { reply({ ok: true, value: { binding: origin, scopeId } }); await pending; });
  assert.equal(requests[0].sessionId, sessionId);
  assert.equal(requests[0].callId, actual.callId);
  assert.equal(opened[0].address, `dsh-resource://file/session/${encodeURIComponent(scopeId)}/${encodeURIComponent("说明 空格.txt")}`);
  assert.equal(projection.getSnapshot().current, current);
  passed("the real native file button waits for authoritative origin and opens its Unicode path without switching the session");

  await act(async () => { pending = button().props.onClick({ stopPropagation() {} }); });
  selection.set({ sessionId: "another-session" });
  await act(async () => { reply({ ok: true, value: { binding: origin, scopeId } }); await pending; });
  assert.equal(opened.length, 1);
  selection.set({ sessionId });
  for (const result of [() => reply({ ok: false, error: { message: "Original target missing" } }), () => rejectReply(new Error("HTTP 503"))]) {
    await act(async () => { pending = button().props.onClick({ stopPropagation() {} }); });
    await act(async () => { result(); await pending; });
    assert.equal(opened.length, 1);
  }
  passed("late origin replies and business or transport failures cannot open a different session's file or use the current target");
} finally {
  if (historyRoot) await act(async () => historyRoot.unmount());
  history.close();
}
console.log(JSON.stringify({ checks, passed: true }));

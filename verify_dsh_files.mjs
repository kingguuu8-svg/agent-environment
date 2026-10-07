/** Render the actual workspace header and native DSH file tree across delivery races. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const React = require("react");
const { act, create } = require("react-test-renderer");
const storeEngine = await import(require.resolve("@deepseek-ai/dsh-client-store"));
const triggerSource = await readFile(require.resolve("@deepseek-ai/dsh-client-ui-input-trigger/package.json").replace("package.json", "lib/client.js"), "utf8");
let nativeTrigger;
runInNewContext(triggerSource, {
  window: { __ModuleLoader__: { load(definition) { nativeTrigger = definition.factory((name) => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return require(name);
    if (name === "@deepseek-ai/dsh-client-store") return storeEngine;
    if (name === "@deepseek-ai/cordis") return { Service: class {} };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
    throw new Error(`Unexpected trigger dependency ${name}`);
  }); } } }, AbortController, console,
});
const clientSource = await readFile(process.argv[2] ?? new URL("./dsh-product/plugin/client.js", import.meta.url), "utf8");
const nativeSource = await readFile(require.resolve("@deepseek-ai/dsh-client-ui-sidebar-files/package.json").replace("package.json", "lib/client.js"), "utf8");
const exportAnchor = "exports.apply = apply;";
assert.equal(nativeSource.split(exportAnchor).length, 2);
let native;
runInNewContext(nativeSource.replace(exportAnchor, `${exportAnchor}\nexports.test = { FilesBody, createFilesStore, filesFace };`), {
  window: { __ModuleLoader__: { load(definition) { native = definition.factory((name) => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return require(name);
    if (name === "@deepseek-ai/dsh-client-store") return storeEngine;
    if (name === "@deepseek-ai/cordis") return {};
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return {
      PathLabel: ({ path }) => React.createElement("span", null, path),
      Tooltip: ({ children }) => children,
      classifyFileType: () => "text",
      ...Object.fromEntries(["IconFolderOpenRegular", "IconFolderCloseRegular", "FileTypeIcon", "IconPauseOutlineRegular", "IconPlayOutlineRegular", "IconRefreshOutlineRegular"].map((key) => [key, () => null])),
    };
    throw new Error(`Unexpected native dependency ${name}`);
  }); } } }, AbortController, AbortSignal,
});

const directory = await mkdtemp(join(tmpdir(), "dsh-file-race-"));
const projectA = join(directory, "project A"), projectB = join(directory, "project B");
await mkdir(projectA); await mkdir(projectB);
await writeFile(join(projectA, "only-a.txt"), "A");
await writeFile(join(projectB, "only-b.txt"), "B");

async function fixture() {
  const a = { id: "cloud", machine: "cloud", workspace: projectA };
  const b = { id: "laptop:project-b", machine: "laptop", workspace: projectB };
  const projection = storeEngine.createSnapshotStore({ current: a, pending: null, revision: 0 });
  const tabs = storeEngine.createSnapshotStore({ expanded: true, tabs: [] });
  const fileStore = native.test.createFilesStore().create("session-1");
  const controllers = new Map(), cleanup = [], listeners = new Map();
  const scope = {};
  let completeCandidates;
  const referenceSource = { name: "reference", trigger: "@", candidates() { return new Promise((resolve) => { completeCandidates = resolve; }); } };
  const trigger = new nativeTrigger.InputTriggerController({ actx: scope, sessionId: "session-1", roster: { all: () => [referenceSource], sources: () => [referenceSource] } });
  let serial = 0, rpcView = { ...projection.getSnapshot(), control: { mine: true }, connection: { status: "online" } }, root;
  const face = native.test.filesFace(async (_sessionId, path, signal) => {
    const entries = (await readdir(path)).map((name) => ({ name, type: "file" }));
    signal.throwIfAborted();
    return { ok: true, value: { entries, truncated: false } };
  }, async function* (_sessionId, _path, signal) {
    yield "ready";
    await new Promise((resolve) => signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }));
  })("session-1", fileStore.actions);
  const sidebar = {
    isExpanded: () => tabs.getSnapshot().expanded,
    tabsIn: () => tabs.getSnapshot().tabs,
    closeIn(_sessionId, id) {
      controllers.get(id)?.abort(); controllers.delete(id);
      tabs.set({ ...tabs.getSnapshot(), tabs: tabs.getSnapshot().tabs.filter((tab) => tab.id !== id) });
    },
    openTab(kind) {
      const id = `tab-${++serial}`;
      controllers.set(id, new AbortController());
      tabs.set({ expanded: true, tabs: [...tabs.getSnapshot().tabs, { id, kind }] });
      return id;
    },
  };
  let definition, Header;
  runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { visibilityState: "visible", documentElement: { dataset: {} }, createElement() { return { remove() {} }; }, head: { append() {} },
      addEventListener(name, callback) { const group = listeners.get(name) ?? new Set(); group.add(callback); listeners.set(name, group); },
      removeEventListener(name, callback) { listeners.get(name)?.delete(callback); } },
    sessionStorage: { getItem() { return null; }, setItem() {} }, performance: { getEntriesByType() { return []; } },
    location: { hash: "", search: "", href: "http://127.0.0.1:1" }, URL, URLSearchParams, crypto: { randomUUID }, AbortController,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
  });
  const plugin = definition.factory((name) => {
    if (name === "react") return React;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
    throw new Error(`Unexpected client dependency ${name}`);
  });
  plugin.apply({
    sessions: { scope: () => scope }, inputTriggers: { sessionOf: () => trigger },
    uiWorkspace: { selection: storeEngine.createSnapshotStore({}), startSession() {} }, sidebarRight: sidebar,
    connection: { rpc: { async call(_channel, endpoint) {
      if (endpoint === "remoteWorkspaces/get") return { ok: true, value: rpcView };
      if (endpoint === "remoteWorkspaces/probe") return { ok: true, value: {} };
      throw new Error(`Unexpected RPC ${endpoint}`);
    } } },
    slots: { inject(name, register) { if (name === "conversation.session.header.utilities") register(); }, register(_options, component) { Header = component; } },
    effect(register) { cleanup.push(register()); },
  });
  const useProjection = () => React.useSyncExternalStore(projection.subscribe, projection.getSnapshot);
  const useStore = (selector) => selector(React.useSyncExternalStore(fileStore.subscribe, fileStore.getSnapshot));
  const Files = ({ tab }) => React.createElement(native.test.FilesBody, {
    sessionId: "session-1", useProjection, useStore, useSessions: (selector) => selector({ byId: { "session-1": { cwd: projectA } } }),
    useTabInfo: () => ({ tab: { ...tab, signal: controllers.get(tab.id).signal, actions: { bindCommands() { return () => {}; } } } }),
    actions: fileStore.actions, ...face, t: (key) => key, renderSlot: () => null,
  });
  function App() {
    const state = React.useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
    return React.createElement(React.Fragment, null,
      React.createElement(Header, { sessionId: "session-1", useProjection }),
      state.expanded ? state.tabs.map((tab) => tab.kind === "files" ? React.createElement(Files, { tab, key: tab.id }) : React.createElement("aside", { key: tab.id, "data-preview": tab.kind }, tab.id)) : null);
  }
  sidebar.openTab("files"); sidebar.openTab("text"); sidebar.openTab("document"); sidebar.openTab("terminal"); sidebar.openTab("custom");
  const settle = async (operation = () => {}) => { await act(async () => { await operation(); await new Promise((resolve) => setImmediate(resolve)); }); };
  await settle(() => { root = create(React.createElement(App)); });
  await settle();
  const tree = () => root.root.findByProps({ "data-files-state": "tree" }).props["data-files-root"];
  const entries = () => root.root.findAll((item) => item.props["data-files-entry"] === "file").map((item) => item.props["data-files-path"]);
  const ready = async (expectedRoot, filename) => {
    const deadline = Date.now() + 2000;
    while (entries().length === 0 && Date.now() < deadline) await settle(() => new Promise((resolve) => setTimeout(resolve, 5)));
    assert.equal(tree(), expectedRoot);
    assert.deepEqual(entries(), [join(expectedRoot, filename)]);
  };
  const notify = async () => settle(() => { for (const listener of listeners.get("visibilitychange") ?? []) listener(); });
  return { a, b, projection, tabs, tree, entries, ready, trigger, completeCandidates(value) { completeCandidates(value); },
    setView(value) { rpcView = { ...value, control: { mine: true }, connection: { status: "online" } }; }, notify, settle,
    async close() { await settle(() => root.unmount()); trigger.dispose(); for (const controller of controllers.values()) controller.abort(); for (const dispose of cleanup.reverse()) dispose?.(); } };
}

let checks = 0;
const passed = (name) => { checks++; console.log("PASS " + name); };
let test;
try {
  test = await fixture();
  await test.ready(projectA, "only-a.txt");
  passed("the actual native file tree initially lists the current project");

  const originalTabs = test.tabs.getSnapshot().tabs;
  test.trigger.track("@only", 5, { tier: "editable" }, 1);
  assert.equal(test.trigger.menu.getSnapshot().open, true);
  test.setView({ current: test.b, pending: null, revision: 1 });
  await test.notify();
  assert.deepEqual(test.tabs.getSnapshot().tabs, originalTabs);
  assert.equal(test.tree(), projectA);
  passed("an RPC arriving first cannot seed a new file tree from the old native projection");
  assert.equal(test.trigger.menu.getSnapshot().open, false);
  test.completeCandidates([{ name: "only-a.txt" }]);
  await test.settle();
  assert.equal(test.trigger.menu.getSnapshot().open, false);
  passed("a switch closes the actual native reference menu and a late old response cannot reopen it");

  await test.settle(() => test.projection.set({ current: test.b, pending: null, revision: 1 }));
  await test.settle();
  await test.ready(projectB, "only-b.txt");
  assert.deepEqual(test.tabs.getSnapshot().tabs.map((tab) => tab.kind), ["custom", "files"]);
  passed("projection catch-up clears prior native previews and renders the new root and files");

  await test.settle(() => test.projection.set({ current: test.a, pending: null, revision: 2 }));
  await test.settle();
  await test.ready(projectA, "only-a.txt");
  const returnedTabs = test.tabs.getSnapshot().tabs;
  test.setView({ current: test.a, pending: null, revision: 2 });
  await test.notify();
  assert.deepEqual(test.tabs.getSnapshot().tabs, returnedTabs);
  passed("projection-first delivery and its later RPC render the old project once without replacing its tabs again");

  test.setView({ current: test.a, pending: test.b, revision: 3 });
  test.trigger.track("@only-b", 7, { tier: "editable" }, 2);
  test.completeCandidates([{ name: "only-a.txt" }]);
  await test.settle();
  await test.notify();
  await test.settle(() => test.projection.set({ current: test.a, pending: test.b, revision: 3 }));
  assert.deepEqual(test.tabs.getSnapshot().tabs, returnedTabs);
  assert.equal(test.tree(), projectA);
  assert.equal(test.trigger.menu.getSnapshot().open, true);
  passed("a pending switch leaves the running project's file tree intact");

  test.setView({ current: test.b, pending: null, revision: 4 });
  await test.notify();
  assert.equal(test.tree(), projectA);
  assert.equal(test.trigger.menu.getSnapshot().open, false);
  await test.settle(() => test.projection.set({ current: test.b, pending: null, revision: 4 }));
  await test.settle();
  await test.ready(projectB, "only-b.txt");
  passed("committing a pending switch uses the same native projection boundary");

  const beforeHidden = test.tabs.getSnapshot().tabs;
  await test.settle(() => test.tabs.set({ expanded: false, tabs: beforeHidden }));
  test.setView({ current: test.a, pending: null, revision: 5 });
  await test.notify();
  await test.settle(() => test.projection.set({ current: test.a, pending: null, revision: 5 }));
  assert.equal(test.tabs.getSnapshot().expanded, false);
  assert.deepEqual(test.tabs.getSnapshot().tabs.map((tab) => tab.kind), ["custom"]);
  passed("switching with a collapsed sidebar clears obsolete file tabs while keeping it closed");
  console.log(JSON.stringify({ checks, passed: true }));
} finally {
  await test?.close();
  await rm(directory, { recursive: true, force: true });
}

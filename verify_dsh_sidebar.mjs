/** Exercise machine grouping through the pinned native workspace browser and its stores. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { createMachineSidebar, patchMachineSidebar } from "./dsh-product/remote-sidebar.mjs";

const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const React = require("react"), { act, create } = require("react-test-renderer");
const stores = await import(require.resolve("@deepseek-ai/dsh-client-store"));
const source = await readFile(require.resolve("@deepseek-ai/dsh-client-ui-workspace/package.json").replace("package.json", "lib/client.js"), "utf8");
assert.ok(source.includes(createMachineSidebar.toString()), "Apply the current sidebar patch before verification");
assert.equal(patchMachineSidebar(source), source);
assert.throws(() => patchMachineSidebar("unsupported build"), /Unsupported/);
const storage = new Map();
const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const primitives = new Proxy({
  Tooltip: ({ children }) => children, HoverCard: ({ anchor }) => anchor,
  Button: ({ children, onClick }) => React.createElement("button", { onClick }, children),
  Toast: () => null,
  Modal: ({ open, children }) => open ? React.createElement("aside", null, children) : null,
  MenuOverlay: ({ open, children }) => open ? React.createElement("aside", null, children) : null,
  Menu: ({ open, onSelect, items = [], anchor, children }) => React.createElement(React.Fragment, null, anchor, open ? React.createElement("aside", null, children,
    items.filter((item) => !item.type).map((item) => React.createElement("button", { key: item.id, onClick: () => onSelect?.(item.id) }, item.label))) : null),
  StateDot: () => null,
  MenuItemButton: ({ children, onClick }) => React.createElement("button", { onClick }, children), relativeTime: () => "now",
}, { get(target, key) { if (key in target) return target[key]; if (String(key).startsWith("Icon")) return () => null; throw new Error(`Unexpected primitive ${String(key)}`); } });
let native;
runInNewContext(source.replace("exports.apply = apply;", "exports.test = { WorkspaceBrowser, createWorkspaceViewStore, deriveGroups };\nexports.apply = apply;"), {
  window: { __ModuleLoader__: { load(definition) { native = definition.factory((name) => {
    if (["react", "react/jsx-runtime"].includes(name)) return require(name);
    if (name === "@deepseek-ai/dsh-client-store") return stores;
    if (name === "@deepseek-ai/cordis") return { Service: class {} };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`Unexpected dependency ${name}`);
  }).test; } }, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout },
  localStorage, setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, AbortController, console,
});
const cloud = { id: "cloud", machine: "cloud", hostname: "cloud-host", workspace: "/cloud" };
const a = { id: "a", machine: "laptop-a", hostname: "laptop-a-host", workspace: "/work/project" };
const b = { id: "b", machine: "laptop-b", hostname: "laptop-b-host", workspace: "/work/project" };
const away = { id: "offline", machine: "offline", hostname: "offline-host", workspace: "C:\\Users\\例子\\project" };
const workspace = (id, target, ids) => ({ workspaceId: id, title: id === "wa" ? "自定义项目" : target.hostname + " · project", path: "/anchors/" + id,
  createdAt: "2026-10-08T00:00:00Z", sessionIds: ids });
const stored = [workspace("wc", cloud, ["sc", "native"]), workspace("wa", a, ["sa", "handoff", "archived", "blank"]), workspace("wb", b, ["sb"])];
const catalog = { machines: [cloud, a, b, away].map((target) => ({ id: target.machine, hostname: target.hostname, label: target.machine })),
  savedWorkspaces: [cloud, a, b].map((target, i) => ({ ...target, workspaceId: stored[i].workspaceId })) };
const initial = { ids: ["sc", "native", "sa", "handoff", "archived", "blank", "sb", "away"], phase: "ready", projectionsBySession: {}, byId: {} };
for (const [index, id] of initial.ids.entries()) initial.byId[id] = { id, title: id, displayTitle: id, cwd: "/anchors/wa", updatedAt: index + 1, blank: id === "blank",
  running: false, retainedBy: id === "handoff" ? { mainView: 1 } : {}, projectionValues: { remoteBinding: { current: id === "away" ? away : id === "sb" ? b : id === "sc" ? cloud : id === "native" ? null : a, pending: null, revision: 0 } } };
const baseline = JSON.stringify({ stored, initial, catalog });
const sidebar = createMachineSidebar(React);
let checks = 0;
const passed = (name) => { checks++; console.log("PASS " + name); };
const projected = sidebar.projectWorkspaces(initial, stored, catalog);
assert.deepEqual(projected.find((group) => group.workspaceId === "wa").sessionIds, ["sa", "handoff", "archived", "blank"]);
assert.equal(projected.find((group) => group.workspaceId === "wa").title, "自定义项目");
assert.equal(projected.find((group) => group.workspaceId === "wa").remoteDisplayTitle, "自定义项目");
assert.equal(projected.find((group) => group.workspaceId === "wb").remoteDisplayTitle, "project");
assert.equal(projected.find((group) => group.workspaceId === "wa").path, a.workspace);
assert.equal(projected.find((group) => group.workspaceId === "wb").remoteMachine, b.machine);
assert.equal(projected.find((group) => group.remoteMachine === away.machine).remoteVirtual, true);
assert.equal(sidebar.projectWorkspaces(initial, stored, null), stored);
assert.equal(JSON.stringify({ stored, initial, catalog }), baseline);
passed("same directory names on different hosts, custom titles, Windows paths and legacy sessions retain distinct display identities without mutating state");

const lists = stores.createSnapshotStore(initial);
const workspaces = stores.createSnapshotStore({ items: stored, phase: "ready", state: "idle", archivedSessionIds: ["archived"], pinnedSessionIds: ["sa"] });
const catalogStore = stores.createSnapshotStore(catalog);
const viewing = native.createWorkspaceViewStore().create();
const use = (store) => (selector) => selector(React.useSyncExternalStore(store.subscribe, store.getSnapshot));
const started = [], prepared = [], opened = [], menus = [], renames = [], reordered = [];
const props = { wide: true, useSessions: use(lists), useWorkspaces: use(workspaces), useStore: use(viewing), actions: viewing.actions,
  remoteSidebarCatalog: catalogStore, remoteSidebarActions: { createWorkspace: (target) => prepared.push(target) },
  useHostInfo: (selector) => selector({ home: "/cloud" }), useShortcuts: (selector) => selector([]), usePanelInfo: (selector) => selector({ activePanelId: null }),
  useSessionStatus: (selector) => selector(new Map()), useDirectoryFlow: (selector) => selector(true),
  useWorkspaceShortcuts: (selector) => selector({ searchRequest: 0, addRequested: false, directoryBusy: false, forkError: null }),
  t: (key) => key, open: (id) => opened.push(id), startSession: (id) => started.push(id), requestSessionRename: (...args) => renames.push(args),
  insertWorkspaceBefore: async (...args) => reordered.push(args), notifyArchivedNotOpenable() {}, searchSessions: async () => ({ items: [], hasMore: false }), searchResultLimit: 20,
  closeAddWorkspace() {}, setDirectoryBusy() {}, dismissForkError() {}, requestSearch() {}, requestAddWorkspace() {},
  renderSlot: (seat, owner) => { if (seat.endsWith("menu.item")) { menus.push(owner.sessionId); return React.createElement("span", null, "原生会话菜单"); } return null; },
};
let root;
const settle = (operation = () => {}) => act(async () => { await operation(); await new Promise((resolve) => setImmediate(resolve)); });
const host = (id) => root.root.findAll((node) => node.type === "section" && node.props["data-remote-host"] === id)[0];
const rows = (node = root.root) => node.findAll((item) => item.type === "div" && item.props["data-row-key"]?.startsWith("session:")).map((item) => item.props["data-row-key"].slice(8));
const header = (id) => host(id).findByProps({ className: "rw-host-heading" });
const project = (id) => root.root.findAll((node) => node.type === "div" && node.props["data-row-key"] === "workspace:" + id)[0];
try {
  await settle(() => { root = create(React.createElement(native.WorkspaceBrowser, props)); viewing.actions.setGroupExpanded("wa", true); viewing.actions.setGroupExpanded("wb", true); viewing.actions.setGroupExpanded("wc", true); });
  assert.deepEqual(root.root.findAllByType("section").map((node) => node.props["data-remote-host"]), ["cloud", a.machine, b.machine, away.machine]);
  assert.deepEqual(rows(host(a.machine)), ["sa", "handoff"]);
  assert.equal(host(a.machine).findByProps({ className: "rw-host-count" }).children[0], "2");
  assert.ok(host(away.machine));
  assert.ok(project("wb").findAllByType("span").some((node) => node.children.includes("project")));
  passed("the actual native sidebar renders host → workspace → sessions with native pin, archive and blank-session visibility");

  await settle(() => { header(b.machine).props.onClick(); });
  assert.equal(header(b.machine).props["aria-expanded"], false); assert.deepEqual(rows(host(b.machine)), []);
  await settle(() => { root.unmount(); root = create(React.createElement(native.WorkspaceBrowser, props)); });
  assert.equal(header(b.machine).props["aria-expanded"], false); assert.deepEqual(rows(host(a.machine)), ["sa", "handoff"]);
  passed("host folding survives reload while the selected host and native folder state remain accessible");

  await settle(() => { const state = lists.getSnapshot(); lists.set({ ...state, byId: { ...state.byId, handoff: { ...state.byId.handoff, projectionValues: { remoteBinding: { current: a, pending: b, revision: 1 } } } } }); });
  assert.ok(rows(host(a.machine)).includes("handoff")); assert.ok(!rows(host(b.machine)).includes("handoff"));
  passed("a pending cross-host switch stays grouped under its actual executing host");

  await settle(() => { const state = lists.getSnapshot(); lists.set({ ...state, projectionsBySession: { handoff: { values: { remoteBinding: { current: { ...b, id: "restored-b-id" }, pending: null, revision: 2 } } } } }); });
  assert.deepEqual(rows(host(a.machine)), ["sa"]); assert.ok(rows(host(b.machine)).includes("handoff"));
  assert.equal(rows().filter((id) => id === "handoff").length, 1);
  assert.equal(header(b.machine).props["aria-expanded"], true);
  assert.equal(host(b.machine).findByProps({ className: "rw-host-count" }).children[0], "2");
  assert.deepEqual(stored, JSON.parse(baseline).stored);
  passed("the live projection moves one session into its current host, opens that host and matches the saved directory even after resource identity changes");

  const newTarget = { ...b, id: "new-b", workspace: "/work/new project" };
  await settle(() => { const state = lists.getSnapshot(); lists.set({ ...state, projectionsBySession: { handoff: { values: { remoteBinding: { current: newTarget, pending: null, revision: 3 } } } } }); });
  const virtual = "remote-target:" + JSON.stringify([b.machine, newTarget.workspace]);
  assert.equal(project(virtual).props.draggable, false);
  await settle(() => project(virtual).findAllByType("button").find((node) => node.props["aria-label"] === "actions.newSession.aria").props.onClick({ stopPropagation() {} }));
  assert.equal(prepared[0].workspace, newTarget.workspace); assert.equal(prepared[0].machine, b.machine);
  await settle(() => project("wa").findAllByType("button").find((node) => node.props["aria-label"] === "actions.newSession.aria").props.onClick({ stopPropagation() {} }));
  assert.deepEqual(started, ["wa"]);
  passed("workspace plus retains the native workspace identity and an unsaved target plus prepares its exact machine and directory");

  const handoffRow = root.root.findAll((node) => node.type === "div" && node.props["data-row-key"] === "session:handoff")[0];
  await settle(() => handoffRow.props.onClick()); assert.deepEqual(opened, ["handoff"]);
  await settle(() => handoffRow.findAllByType("button").find((node) => node.props["aria-label"] === "actions.session.aria").props.onClick({ stopPropagation() {} }));
  assert.ok(menus.includes("handoff"));
  passed("opening a moved conversation and its original row menu still addresses the same session");

  await settle(() => viewing.actions.setArchivedFilter("only"));
  assert.deepEqual(rows(), ["archived"]); assert.equal(host(a.machine).findByProps({ className: "rw-host-count" }).children[0], "1");
  await settle(() => { viewing.actions.setArchivedFilter("default"); viewing.actions.setGroupBy("flat"); });
  assert.equal(root.root.findAllByProps({ className: "rw-host-heading" }).length, 0); assert.equal(rows().filter((id) => id === "handoff").length, 1);
  passed("archive-only filtering and the optional flat view retain native results without duplicate sessions");

  await settle(() => { viewing.actions.setGroupBy("workspace-tree"); });
  assert.equal(project("wa").props.style, undefined); assert.ok(project("wb"));
  assert.equal(host(a.machine).findAll((node) => node.props["data-row-key"] === "workspace:wb").length, 0);
  passed("the directory-tree view keeps identical paths on different hosts in their own host groups");

  const withNested = { ...catalog, savedWorkspaces: [...catalog.savedWorkspaces, { ...a, workspace: "/work/project/nested", workspaceId: "nested" }] };
  await settle(() => {
    catalogStore.set(withNested);
    workspaces.set({ ...workspaces.getSnapshot(), items: [...stored, workspace("nested", a, ["nested-session"])] });
    const list = lists.getSnapshot(); lists.set({ ...list, ids: [...list.ids, "nested-session"], byId: { ...list.byId, "nested-session": {
      ...list.byId.sa, id: "nested-session", retainedBy: {}, projectionValues: { remoteBinding: { current: { ...a, workspace: "/work/project/nested" } } },
    } } });
  });
  assert.ok(host(a.machine).findAll((node) => node.props["data-row-key"] === "workspace:nested").length);
  assert.equal(host(a.machine).findByProps({ className: "rw-host-count" }).children[0], "2");
  assert.ok(!rows(host(a.machine)).includes("nested-session"));
  passed("nested workspace headings and host totals remain correct with folder nesting enabled");
} finally { await settle(() => root?.unmount()); }

// Use the real root-source publication contract, as well as the real native
// browser above: incorrectly placing props beside `props` silently drops them.
const rendererSource = await readFile(require.resolve("@deepseek-ai/dsh-client-ui-renderer/package.json").replace("package.json", "lib/client.js"), "utf8");
const slotCore = await import(require.resolve("@deepseek-ai/dsh-client-ui-slots"));
let SlotRegistry;
runInNewContext(rendererSource, { window: { __ModuleLoader__: { load(definition) {
  SlotRegistry = definition.factory((name) => name === "@deepseek-ai/cordis" ? { Service: class { constructor(ctx) { this.ctx = ctx; } } }
    : name === "@deepseek-ai/dsh-client-ui-slots" ? slotCore : name.startsWith("react-dom") ? {} : require(name)).SlotRegistry;
} } }, console, queueMicrotask });
const cleanup = [], visible = new Set(), calls = [], created = [], selected = [], sessionState = new Map();
let failure = true, plugin, disposed = false;
const effect = (register) => { const dispose = register(); cleanup.push(dispose); return dispose; };
const registry = new SlotRegistry({ effect, emit() {} });
const clientSource = await readFile(new URL("./dsh-product/plugin/client.js", import.meta.url), "utf8");
runInNewContext(clientSource, {
  window: { __ModuleLoader__: { load(definition) { plugin = definition.factory((name) => name === "react" ? React : { Modal: primitives.Modal }); } } },
  document: { visibilityState: "visible", documentElement: { dataset: {} }, createElement: () => ({ remove() {} }), head: { append() {} },
    addEventListener(name, listener) { if (name === "visibilitychange") visible.add(listener); }, removeEventListener(_name, listener) { visible.delete(listener); } },
  sessionStorage: { getItem: (key) => sessionState.get(key) ?? null, setItem: (key, value) => sessionState.set(key, value), removeItem: (key) => sessionState.delete(key) },
  performance: { getEntriesByType: () => [] }, location: { hash: "", search: "", href: "http://fixture" }, URL, URLSearchParams,
  crypto: { randomUUID }, AbortController, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
});
plugin.apply({ effect,
  connection: { rpc: { async call(_channel, endpoint, payload) {
    assert.equal(disposed, false); calls.push({ endpoint, request: payload.args.request });
    if (endpoint === "remoteWorkspaces/catalog") { if (failure) throw new Error("fixture offline"); return { ok: true, value: catalog }; }
    if (endpoint === "remoteWorkspaces/pick") return { ok: true, value: { workspaceId: "picked-workspace", binding: away } };
    if (endpoint === "remoteWorkspaces/control") return { ok: true, value: { current: away, control: { mine: true }, draft: { revision: 0, text: "" } } };
    throw new Error("Unexpected RPC " + endpoint);
  } } },
  sessions: { create: async (request) => { created.push(request); return request.sessionId; } }, workspaces: { list: workspaces },
  uiWorkspace: { selection: stores.createSnapshotStore({}), startSession() {}, openSession: (id) => selected.push(id) },
  slots: { inject(name, register) { if (name === "sidebar.workspaces") cleanup.push(register()); }, provideRoot: registry.provideRoot.bind(registry) },
});
try {
  await settle();
  const published = registry._rootSource.getSnapshot().props;
  assert.equal(published.remoteSidebarCatalog.getSnapshot(), null);
  assert.ok(calls.every((call) => call.endpoint === "remoteWorkspaces/catalog"));
  failure = false;
  await settle(() => { for (const listener of visible) listener(); });
  assert.deepEqual(published.remoteSidebarCatalog.getSnapshot(), catalog);
  passed("the actual plugin publishes native root props, retries initial catalog failure and loads host metadata using read-only requests");
  await settle(() => published.remoteSidebarActions.createWorkspace(away));
  const picked = calls.find((call) => call.endpoint === "remoteWorkspaces/pick").request;
  assert.equal(picked.machine, away.machine); assert.equal(picked.workspace, away.workspace);
  assert.equal(created.length, 1); assert.equal(created[0].workspaceId, "picked-workspace"); assert.equal(selected[0], created[0].sessionId);
  passed("the real unsaved-directory action prepares the specified host then creates and opens one native session with the returned workspace identity");
} finally {
  for (const dispose of cleanup.reverse()) dispose?.();
  disposed = true;
  assert.equal(registry._rootSource.getSnapshot().props.remoteSidebarCatalog, undefined);
  assert.equal(visible.size, 0);
}
passed("plugin disposal removes its root props and refresh listeners");
console.log(JSON.stringify({ checks, realNativeBrowser: true, productionModelRequests: 0 }));

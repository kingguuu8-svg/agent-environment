import { createHash } from "node:crypto";

/** Display current execution targets without rewriting DSH's durable workspace accounts. */
export function createMachineSidebar(React) {
  const h = React.createElement;
  const targetKey = (target) => JSON.stringify([target.machine, target.workspace]);
  const folderName = (target) => target.workspace.split(/[\\/]/).filter(Boolean).at(-1) || "/";
  const shortTarget = (target) => `${target.hostname || target.machine} · ${folderName(target)}`;
  const noSubscribe = () => () => {};
  const noCatalog = () => null;

  function projectWorkspaces(list, stored, catalog) {
    if (!catalog) return stored;
    const machines = new Map(catalog.machines.map((machine) => [machine.id, machine]));
    const saved = new Map(catalog.savedWorkspaces.map((workspace) => [workspace.workspaceId, workspace]));
    const targets = new Map();
    const groups = stored.map((workspace) => {
      const target = saved.get(workspace.workspaceId);
      const machine = target?.machine ?? "cloud";
      const host = machines.get(machine);
      const group = { ...workspace, path: target?.workspace ?? workspace.path, sessionIds: [], remoteMachine: machine,
        remoteMachineLabel: host?.hostname || target?.hostname || host?.label || machine,
        remoteDisplayTitle: target && [shortTarget(target), shortTarget({ ...target, hostname: host?.hostname })].includes(workspace.title) ? folderName(target) : workspace.title,
        remoteTarget: target, remoteMachineOrder: catalog.machines.findIndex((item) => item.id === machine) };
      if (target) targets.set(targetKey(target), group);
      return group;
    });
    const owners = new Map();
    for (const workspace of stored) for (const id of workspace.sessionIds) if (!owners.has(id)) owners.set(id, workspace.workspaceId);
    const byId = new Map(groups.map((group) => [group.workspaceId, group]));
    const assigned = new Set();
    for (const id of [...stored.flatMap((workspace) => workspace.sessionIds), ...list.ids]) {
      if (assigned.has(id) || !list.byId[id]) continue;
      assigned.add(id);
      const current = (list.projectionsBySession?.[id]?.values?.remoteBinding ?? list.byId[id].projectionValues?.remoteBinding)?.current;
      let group = byId.get(owners.get(id));
      if (current) {
        const key = targetKey(current);
        group = targets.get(key);
        if (!group) {
          const host = machines.get(current.machine);
          group = { workspaceId: `remote-target:${key}`, path: current.workspace, title: shortTarget(current), createdAt: "1970-01-01T00:00:00.000Z",
            sessionIds: [], remoteMachine: current.machine, remoteMachineLabel: host?.hostname || current.hostname || host?.label || current.machine,
            remoteDisplayTitle: folderName(current),
            remoteMachineOrder: catalog.machines.findIndex((item) => item.id === current.machine), remoteTarget: current, remoteVirtual: true };
          groups.push(group); targets.set(key, group);
        }
      }
      if (group) group.sessionIds.push(id);
    }
    return groups;
  }

  function useCatalog(source) {
    return React.useSyncExternalStore(source?.subscribe ?? noSubscribe, source?.getSnapshot ?? noCatalog);
  }

  function MachineGroup({ machine, current, revealSessionId }) {
    const [collapsed, setCollapsed] = React.useState(() => {
      try { return !current && JSON.parse(localStorage.getItem("remote-dsh-collapsed-machines") || "[]").includes(machine.id); } catch { return false; }
    });
    const wasCurrent = React.useRef(current);
    React.useEffect(() => {
      if (current && (!wasCurrent.current || revealSessionId)) setCollapsed(false);
      wasCurrent.current = current;
    }, [current, revealSessionId]);
    const toggle = () => {
      const next = !collapsed; setCollapsed(next);
      try {
        const ids = new Set(JSON.parse(localStorage.getItem("remote-dsh-collapsed-machines") || "[]"));
        if (next) ids.add(machine.id); else ids.delete(machine.id);
        localStorage.setItem("remote-dsh-collapsed-machines", JSON.stringify([...ids]));
      } catch {}
    };
    return h("section", { className: "rw-host-group", "data-remote-host": machine.id, "aria-label": machine.label },
      h("button", { type: "button", className: "rw-host-heading", "aria-expanded": !collapsed, onClick: toggle,
        "data-current": current || undefined, "data-row-key": `machine:${machine.id}` },
        h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true },
          h("path", { d: "M3 4h18v12H3ZM8 21h8M12 16v5" })),
        h("span", { className: "rw-host-name" }, machine.label),
        h("span", { className: "rw-host-count", title: `${machine.count} 个会话` }, machine.count),
        h("span", { className: "rw-host-chevron", "aria-hidden": true }, collapsed ? "›" : "⌄")),
      !collapsed && h("div", { role: "group" }, machine.rows));
  }

  function renderGroups(rootGroups, workspaces, renderGroup, currentGroup, revealSessionId, rowKeys, allGroups) {
    if (!workspaces.some((workspace) => workspace.remoteMachine)) return rootGroups.map((group) => renderGroup(group, 0));
    const metadata = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
    const machines = new Map();
    for (const group of rootGroups) {
      const workspace = metadata.get(group.key);
      const id = workspace?.remoteMachine ?? "cloud";
      if (!machines.has(id)) machines.set(id, { id, label: workspace?.remoteMachineLabel ?? "云端", order: workspace?.remoteMachineOrder ?? 0, count: 0, rows: [], current: false });
      const machine = machines.get(id);
      const members = workspaces.filter((item) => item.remoteMachine === id);
      machine.current ||= members.some((item) => item.workspaceId === currentGroup) || group.containsCurrent;
      // Native groups retain filtering, counts, menus, order and row limits.
      machine.rows.push(renderGroup(group, 1));
    }
    // Include nested workspace counts once, independently of folder expansion.
    for (const machine of machines.values()) {
      machine.count = allGroups.filter((group) => (metadata.get(group.key)?.remoteMachine ?? "cloud") === machine.id).reduce((sum, group) => sum + group.sessionCount, 0);
    }
    return [...machines.values()].sort((a, b) => (a.order < 0 ? Infinity : a.order) - (b.order < 0 ? Infinity : b.order)).map((machine) => {
      rowKeys.push(`machine:${machine.id}`);
      return h(MachineGroup, { key: machine.id, machine, current: machine.current, revealSessionId });
    });
  }

  return { projectWorkspaces, useCatalog, renderGroups };
}

/** Checked integration points into the pinned native sidebar; all row actions stay upstream. */
export function patchMachineSidebar(source) {
  const marker = "// remote-dsh-workspaces: group the sidebar by current execution machine.";
  if (source.includes(marker)) {
    if (!source.includes(createMachineSidebar.toString())) throw new Error("Reinstall the pinned DSH package before updating its machine sidebar patch");
    return source;
  }
  if (createHash("sha256").update(source).digest("hex") !== "e784543780fb8ac7c38c853afd26b9b1713c6907eec2b07eff37461e07bd3be9") throw new Error("Unsupported DSH workspace-sidebar build");
  const edits = [
    ['function WorkspaceBrowser({ wide,', 'function WorkspaceBrowser({ remoteSidebarCatalog, remoteSidebarActions, wide,'],
    ['const storedWorkspaces = useWorkspaces((state) => state.items);', 'const storedWorkspaces = useWorkspaces((state) => state.items);\n\t\t\tconst remoteCatalog = machineSidebar.useCatalog(remoteSidebarCatalog);'],
    ['() => storedWorkspaces.map((workspace) => ({', '() => machineSidebar.projectWorkspaces(list, storedWorkspaces, remoteCatalog).map((workspace) => ({'],
    ['})), [storedWorkspaces, defaultWorkspaceName]);', '})), [list, storedWorkspaces, remoteCatalog, defaultWorkspaceName]);'],
    ['function SessionTree({ list,', 'function SessionTree({ remoteSidebarActions, list,'],
    ['function ProjectRowItem({ group,', 'function ProjectRowItem({ displayLabel, group,'],
    ['const label = row.workspaceId === void 0 ? t("group.ungrouped") : row.label;', 'const label = row.workspaceId === void 0 ? t("group.ungrouped") : displayLabel ?? row.label;'],
    ['newShortcut: shortcuts.find((row) => row.id === "session.new"),\n\t\t\t\t\t\t\tgroup,', 'newShortcut: shortcuts.find((row) => row.id === "session.new"),\n\t\t\t\t\t\t\tdisplayLabel: remoteWorkspace?.remoteDisplayTitle,\n\t\t\t\t\t\t\tgroup,'],
    ['const keysByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace.workspaceId]));\n\t\t\t\tconst paths = [...keysByPath.keys()];\n\t\t\t\treturn new Map(workspaces.map((workspace) => {\n\t\t\t\t\tconst path = owningParentFolder(workspace.path, paths);\n\t\t\t\t\treturn [workspace.workspaceId, path === void 0 ? void 0 : keysByPath.get(path)];',
      'return new Map(workspaces.map((workspace) => {\n\t\t\t\t\tconst peers = workspaces.filter((item) => item.remoteMachine === workspace.remoteMachine);\n\t\t\t\t\tconst keysByPath = new Map(peers.map((item) => [item.path, item.workspaceId]));\n\t\t\t\t\tconst path = owningParentFolder(workspace.path, [...keysByPath.keys()]);\n\t\t\t\t\treturn [workspace.workspaceId, path === void 0 ? void 0 : keysByPath.get(path)];'],
    ['const workspaceId = group.workspaceId;\n\t\t\t\tconst children', 'const workspaceId = group.workspaceId;\n\t\t\t\tconst remoteWorkspace = workspaces.find((workspace) => workspace.workspaceId === workspaceId);\n\t\t\t\tconst children'],
    ['const compatibleDrag = workspaceDrag !== null && parents.get(workspaceDrag.workspaceId) === parents.get(group.key);', 'const compatibleDrag = workspaceDrag !== null && !remoteWorkspace?.remoteVirtual && workspaces.find((workspace) => workspace.workspaceId === workspaceDrag.workspaceId)?.remoteMachine === remoteWorkspace?.remoteMachine && parents.get(workspaceDrag.workspaceId) === parents.get(group.key);'],
    ['const siblings = workspaces.filter((workspace) => parents.get(workspace.workspaceId) === owner);', 'const machine = workspaces.find((workspace) => workspace.workspaceId === activeDrag.workspaceId)?.remoteMachine;\n\t\t\t\tconst siblings = workspaces.filter((workspace) => !workspace.remoteVirtual && workspace.remoteMachine === machine && parents.get(workspace.workspaceId) === owner);'],
    ['const workspaceDragProps = workspaceId === void 0 ? void 0 : {', 'const workspaceDragProps = workspaceId === void 0 || remoteWorkspace?.remoteVirtual ? void 0 : {'],
    ['startSession(group.workspaceId);', 'if (remoteWorkspace?.remoteVirtual) remoteSidebarActions.createWorkspace(remoteWorkspace.remoteTarget);\n\t\t\t\t\t\t\t\t\telse startSession(group.workspaceId);'],
    ['actions: group.workspaceId === void 0 ? void 0 : {', 'actions: group.workspaceId === void 0 || remoteWorkspace?.remoteVirtual ? void 0 : {'],
    ['const groupRows = rootGroups.map((group) => renderGroup(group, 0));', 'const groupRows = machineSidebar.renderGroups(rootGroups, workspaces, renderGroup, currentGroup, revealSessionId, rowKeys, groups);'],
    ['}) : (0, react_jsx_runtime.jsx)(SessionTree, {', '}) : (0, react_jsx_runtime.jsx)(SessionTree, {\n\t\t\t\t\t\t\tremoteSidebarActions,'],
    ['"groupBy.workspace": "按工作区",', '"groupBy.workspace": "按主机和工作区",'],
    ['"groupBy.workspace": "WorkSpace",', '"groupBy.workspace": "Machine and Workspace",'],
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error(`DSH machine-sidebar integration anchor changed: ${before}`);
    source = source.replace(before, after);
  }
  const anchor = 'let react = require("react");';
  if (source.split(anchor).length !== 2) throw new Error("DSH machine-sidebar React anchor changed");
  return source.replace(anchor, `${anchor}\n\t\t${marker}\n\t\tconst machineSidebar = (${createMachineSidebar.toString()})(react);`);
}

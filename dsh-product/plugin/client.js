window.__ModuleLoader__.load({
  id: "remote-dsh-workspaces",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useRef, useSyncExternalStore } = React;
    const inject = ["connection", "sessions", "workspaces", "slots", "uiWorkspace", "layout", "sidebarRight"];

    function apply(ctx) {
      const clientId = crypto.randomUUID();
      document.documentElement.dataset.remoteDshClient = clientId;
      const entry = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
      const originMachine = entry.get("machine") ?? "cloud";
      const originWorkspace = entry.get("workspace");
      const label = originMachine === "cloud" ? "VPS4 Web" : `${originMachine} Web`;
      const originalCall = ctx.connection.rpc.call.bind(ctx.connection.rpc);
      const leases = new Map();
      const listeners = new Set();
      let createOpen = false;
      let creation = { busy: false, error: "", workspaceId: null };
      let creatingSession = null;
      const notifyCreation = () => { for (const listener of listeners) listener(); };
      const openCreate = () => { if (creatingSession) return; createOpen = true; creation = { busy: false, error: "", workspaceId: null }; notifyCreation(); };
      const closeCreate = () => { createOpen = false; notifyCreation(); };
      const api = async (method, request, signal) => {
        const result = await originalCall("/api", `remoteWorkspaces/${method}`, { args: { request } }, signal);
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      };
      const control = async (sessionId, takeover = false) => {
        const value = await api("control", { sessionId, clientId, label, takeover });
        leases.set(sessionId, value);
        return value;
      };
      const createInWorkspace = (workspaceId) => {
        if (creatingSession) return creatingSession;
        creation = { busy: true, error: "", workspaceId }; notifyCreation();
        creatingSession = (async () => {
          const sessionId = await ctx.sessions.create({ workspaceId });
          await control(sessionId);
          ctx.uiWorkspace.openSession(sessionId);
          return sessionId;
        })().catch((error) => {
          creation = { busy: false, error: error.message, workspaceId };
          throw error;
        }).finally(() => {
          creatingSession = null;
          creation = { ...creation, busy: false }; notifyCreation();
        });
        return creatingSession;
      };
      const controlled = async (method, request, signal) => {
        const value = leases.get(request.sessionId) ?? await control(request.sessionId);
        if (!value.control?.mine) throw new Error("此窗口正在查看会话。点击顶部“接管输入”后即可操作。");
        return api(method, { ...request, clientId, epoch: value.control.epoch }, signal);
      };
      const wrappedCall = async (channel, endpoint, payload, signal) => {
        if (channel === "/api" && /^session\/(prompt|cancel|updateQueue|selectModel|rename)$/.test(endpoint)) {
          const request = payload.args.request;
          try {
            const value = leases.get(request.sessionId) ?? await control(request.sessionId);
            if (!value.current) return originalCall(channel, endpoint, payload, signal);
            const result = await controlled("input", { sessionId: request.sessionId, method: endpoint.split("/")[1], payload: request }, signal);
            return { ok: true, value: result };
          } catch (error) { return { ok: false, error: { code: "gateway/bad-request", message: error.message, details: {} } }; }
        }
        return originalCall(channel, endpoint, payload, signal);
      };
      ctx.connection.rpc.call = wrappedCall;
      ctx.effect(() => () => { if (ctx.connection.rpc.call === wrappedCall) ctx.connection.rpc.call = originalCall; }, "remote: controlled input");
      const startSession = ctx.uiWorkspace.startSession;
      const startRemoteSession = (workspaceId) => {
        if (workspaceId !== undefined) createInWorkspace(workspaceId).catch(() => {});
        else openCreate();
      };
      ctx.uiWorkspace.startSession = startRemoteSession;
      ctx.effect(() => () => { if (ctx.uiWorkspace.startSession === startRemoteSession) ctx.uiWorkspace.startSession = startSession; }, "remote: new session flow");
      const style = document.createElement("style");
      style.textContent = `
        .rw-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:inherit;max-width:100%}
        .rw-target{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:.85}
        .rw-button{border:1px solid #80808050;background:transparent;color:inherit;border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer}
        .rw-button:hover{background:#80808018}.rw-button:disabled{opacity:.45;cursor:wait}
        .rw-primary{background:#356be8;color:white;border-color:transparent}.rw-primary:hover{background:#2d5bcc}
        .rw-meta{font-size:12px;opacity:.7}.rw-pending{font-size:12px;color:#c68c21;max-width:350px}
        .rw-error{color:#d46161;white-space:pre-wrap;font-size:13px}
        .rw-status{position:fixed;right:24px;bottom:24px;z-index:1100;background:var(--color-bg-primary,#202124);border:1px solid #80808050;border-radius:10px;padding:12px 16px;display:flex;align-items:center;gap:10px;max-width:480px;box-shadow:0 8px 24px #0003}
        .rw-backdrop{position:fixed;inset:0;background:#0007;z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px}
        .rw-dialog{background:var(--color-bg-primary,#202124);color:var(--color-text-primary,#eee);border:1px solid #80808050;border-radius:16px;width:620px;max-width:100%;box-shadow:0 24px 80px #0006;padding:24px;font-family:inherit}
        .rw-dialog h2{margin:0 0 8px;font-size:20px}.rw-description{font-size:13px;opacity:.7;margin:0 0 20px}
        .rw-row{display:flex;align-items:center;gap:8px;margin-bottom:12px}.rw-row label{min-width:42px;font-size:13px}
        .rw-input,.rw-select{flex:1;min-width:0;border:1px solid #80808060;border-radius:8px;background:#80808012;color:inherit;font:inherit;padding:9px 11px}
        .rw-select option{background:#252629;color:#eee}.rw-path{font-size:13px}.rw-folders{height:270px;overflow:auto;border:1px solid #80808040;border-radius:10px;padding:6px}
        .rw-folder{display:flex;gap:12px;align-items:center;width:100%;border:0;background:transparent;color:inherit;padding:9px 11px;text-align:left;border-radius:6px;cursor:pointer;font:inherit;font-size:14px}
        .rw-folder:hover{background:#80808020}.rw-folder span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .rw-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px}.rw-footer-actions{display:flex;gap:8px}
        .rw-empty{padding:32px;text-align:center;opacity:.65;font-size:13px}
        @media(prefers-color-scheme:light){.rw-dialog{background:var(--color-bg-primary,#fff);color:var(--color-text-primary,#222)}.rw-select option{background:#fff;color:#222}}
      `;
      document.head.append(style);
      ctx.effect(() => () => style.remove(), "remote: styles");

      function DirectoryDialog({ title, initial, busy: ownerBusy, onChoose, onCancel }) {
        const [machines, setMachines] = useState([]);
        const [machine, setMachine] = useState(initial?.machine ?? originMachine);
        const [path, setPath] = useState(initial?.workspace ?? originWorkspace ?? "");
        const [listing, setListing] = useState(null);
        const [loading, setLoading] = useState(false);
        const [saving, setSaving] = useState(false);
        const [error, setError] = useState("");
        const [hidden, setHidden] = useState(false);
        const lifetime = useRef();
        const generation = useRef(0);
        const committing = useRef(false);
        const busy = saving || ownerBusy;
        const scan = async (selectedMachine, directory) => {
          const ticket = ++generation.current;
          lifetime.current?.abort();
          const abort = new AbortController(); lifetime.current = abort;
          setLoading(true); setError(""); setListing(null);
          try {
            const value = await api("browse", { machine: selectedMachine, ...(directory ? { path: directory } : {}) }, abort.signal);
            if (ticket === generation.current && !abort.signal.aborted) { setListing(value); setPath(value.absolutePath); }
          } catch (failure) { if (ticket === generation.current && !abort.signal.aborted) setError(failure.message); }
          finally { if (ticket === generation.current) setLoading(false); }
        };
        useEffect(() => {
          const controller = new AbortController();
          api("catalog", {}, controller.signal).then((value) => {
            if (controller.signal.aborted) return;
            setMachines(value.machines);
            const chosen = value.machines.find((item) => item.id === machine) ?? value.machines[0];
            setMachine(chosen.id);
            scan(chosen.id, path || chosen.workspace);
          }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
          return () => { controller.abort(); lifetime.current?.abort(); generation.current++; };
        }, []);
        useEffect(() => {
          const close = (event) => { if (event.key === "Escape" && !busy) onCancel(); };
          document.addEventListener("keydown", close);
          return () => document.removeEventListener("keydown", close);
        }, [busy, onCancel]);
        const commit = async () => {
          if (!listing || busy || loading || committing.current) return;
          committing.current = true;
          setSaving(true); setError("");
          try { await onChoose({ machine, workspace: listing.absolutePath }); }
          catch (failure) { committing.current = false; setError(failure.message); setSaving(false); }
        };
        const parent = listing?.absolutePath.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
        return h("div", { className: "rw-backdrop", onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onCancel(); } },
          h("section", { className: "rw-dialog", role: "dialog", "aria-modal": true, "aria-label": title },
            h("h2", null, title), h("p", { className: "rw-description" }, "选择执行机器和已有目录。Agent 与会话记录保存在 VPS4。"),
            h("div", { className: "rw-row" }, h("label", { htmlFor: "rw-machine" }, "机器"), h("select", { id: "rw-machine", className: "rw-select", value: machine, disabled: busy, onChange: (event) => {
              const chosen = event.target.value; setMachine(chosen); scan(chosen, machines.find((item) => item.id === chosen)?.workspace);
            } }, machines.map((item) => h("option", { key: item.id, value: item.id }, item.label)))),
            h("form", { className: "rw-row", onSubmit: (event) => { event.preventDefault(); scan(machine, path); } }, h("label", { htmlFor: "rw-directory" }, "目录"), h("input", { id: "rw-directory", className: "rw-input rw-path", value: path, autoFocus: true, disabled: busy, onChange: (event) => setPath(event.target.value) }), h("button", { type: "submit", className: "rw-button", disabled: busy }, "前往")),
            h("div", { className: "rw-row" }, h("button", { type: "button", className: "rw-button", disabled: busy || loading, onClick: () => scan(machine, listing?.home) }, "主目录"), h("button", { type: "button", className: "rw-button", disabled: busy || loading || listing?.absolutePath === "/", onClick: () => scan(machine, parent) }, "上一级"), h("label", { className: "rw-meta" }, h("input", { type: "checkbox", checked: hidden, onChange: (event) => setHidden(event.target.checked) }), " 显示隐藏目录")),
            h("div", { className: "rw-folders", "aria-label": "远端目录" }, loading ? h("div", { className: "rw-empty" }, "正在读取机器目录…") : !listing ? h("div", { className: "rw-empty" }, "目录尚未就绪") : listing.entries.filter((item) => item.type === "directory" && (hidden || !item.name.startsWith("."))).map((item) => h("button", { key: item.name, className: "rw-folder", type: "button", disabled: busy, onClick: () => scan(machine, listing.absolutePath.replace(/\/$/, "") + "/" + item.name) }, h("span", { "aria-hidden": true }, "▣"), h("span", null, item.name))),
              !loading && listing && !listing.entries.some((item) => item.type === "directory" && (hidden || !item.name.startsWith("."))) ? h("div", { className: "rw-empty" }, "此目录下没有可显示的子目录") : null),
            error ? h("p", { role: "alert", className: "rw-error" }, error) : null,
            h("div", { className: "rw-footer" }, h("span", { className: "rw-meta" }, listing?.truncated ? "目录较多，可输入完整路径前往。" : "使用当前显示的目录"), h("div", { className: "rw-footer-actions" }, h("button", { type: "button", className: "rw-button", disabled: busy, onClick: onCancel }, "取消"), h("button", { type: "button", className: "rw-button rw-primary", disabled: busy || loading || !listing, onClick: commit }, busy ? "正在连接…" : "选择此目录")))
          ));
      }

      function NewSessionFlow() {
        const open = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => createOpen);
        const status = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => creation);
        if (!open) return status.busy || status.error ? h("div", { className: "rw-status", role: status.error ? "alert" : "status" },
          h("span", { className: status.error ? "rw-error" : "rw-meta" }, status.error ? `新建会话失败：${status.error}` : "正在新建会话…"),
          status.error ? h("button", { className: "rw-button", onClick: () => createInWorkspace(status.workspaceId).catch(() => {}) }, "重试") : null,
          status.error ? h("button", { className: "rw-button", onClick: () => { creation = { busy: false, error: "", workspaceId: null }; notifyCreation(); } }, "关闭") : null) : null;
        return h(DirectoryDialog, { title: "新建云端会话", onCancel: closeCreate, onChoose: async (chosen) => {
          const picked = await api("pick", chosen);
          // Use DSH's controller so its local workspace snapshot receives the
          // authoritative row before session selection and startup recovery.
          const group = await ctx.workspaces.create({ path: picked.cwd });
          await createInWorkspace(group.workspaceId);
          closeCreate();
        } });
      }
      function WorkspaceDirectoryFlow({ open, busy, onPicked, onCancel, onError }) {
        if (!open) return null;
        return h(DirectoryDialog, { title: "添加机器工作区", busy, onCancel, onChoose: async (chosen) => {
          const picked = await api("pick", chosen);
          onPicked(picked.cwd);
        } });
      }
      function WorkspaceHeader({ sessionId, useProjection }) {
        const binding = useProjection("remoteBinding");
        const [state, setState] = useState(null);
        const [choosing, setChoosing] = useState(false);
        const [error, setError] = useState("");
        const previousTarget = useRef();
        const setView = (value) => { leases.set(sessionId, value); setState((previous) => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); };
        useEffect(() => {
          if (!sessionId) return;
          let disposed = false;
          const abort = new AbortController();
          const refresh = async () => {
            try {
              let value = await api("get", { sessionId, clientId }, abort.signal);
              if (!value.control) value = await control(sessionId);
              if (!disposed) { setView(value); setError(""); }
            } catch (failure) { if (!disposed) setError(failure.message); }
          };
          refresh(); const timer = setInterval(refresh, 2000);
          return () => { disposed = true; abort.abort(); clearInterval(timer); };
        }, [sessionId]);
        useEffect(() => {
          const current = binding?.current?.id;
          if (previousTarget.current && current && previousTarget.current !== current) {
            const sidebar = ctx.sidebarRight;
            const visible = sidebar.isExpanded();
            // Old previews and terminals belong to the previous execution world.
            for (const tab of sidebar.tabsIn(sessionId)) {
              if (["files", "text", "document", "terminal"].includes(tab.kind)) sidebar.closeIn(sessionId, tab.id);
            }
            if (visible) sidebar.openTab("files");
          }
          previousTarget.current = current;
        }, [binding?.current?.id, sessionId]);
        const current = binding?.current ?? state?.current;
        if (!current) return null;
        const shortTarget = (target) => `${target.hostname ?? target.machine} · ${target.workspace.split("/").filter(Boolean).at(-1) || "/"}`;
        const shown = state?.current?.id === current.id ? { ...current, hostname: state.current.hostname ?? current.hostname } : current;
        const mine = state?.control?.mine;
        const pending = binding?.pending ?? state?.pending;
        return h("div", { className: "rw-bar", "data-remote-machine": current.machine, "data-remote-workspace": current.workspace },
          h("span", { className: "rw-target", title: `${shown.hostname ?? current.machine} · ${current.workspace}` }, shortTarget(shown)),
          h("button", { type: "button", className: "rw-button", disabled: !mine, onClick: () => setChoosing(true) }, "切换工作区"),
          h("button", { type: "button", className: "rw-button", onClick: async () => {
            try { setView(await control(sessionId, true)); setError(""); } catch (failure) { setError(failure.message); }
          } }, mine ? "正在控制" : "接管输入"),
          !mine && state?.control ? h("span", { className: "rw-meta" }, `查看模式 · ${state.control.label} 正在控制`) : null,
          pending ? h("span", { className: "rw-pending", title: `${pending.machine} · ${pending.workspace}` }, `当前任务结束后切换至 ${shortTarget(pending)}`, mine ? h("button", { type: "button", className: "rw-button", onClick: async () => {
            try { setView(await controlled("discardSwitch", { sessionId })); } catch (failure) { setError(failure.message); }
          } }, "撤回") : null) : null,
          error ? h("span", { role: "alert", className: "rw-error" }, error) : null,
          choosing ? h(DirectoryDialog, { title: "切换会话工作区", initial: current, onCancel: () => setChoosing(false), onChoose: async (chosen) => {
            const value = await controlled("switch", { sessionId, revision: binding?.revision ?? state.revision, ...chosen });
            setView(value); setChoosing(false);
          } }) : null);
      }

      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "remote-new-session" }, NewSessionFlow));
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: "remote-workspace", order: -100 }, WorkspaceHeader));
      ctx.slots.inject("conversation.hero.agentPreset", () => ctx.slots.register({ name: "conversation.hero.agentPreset", id: "remote-hero-workspace", priority: -100 }, WorkspaceHeader));
      ctx.slots.inject("conversation.input.permission", () => ctx.slots.register({ name: "conversation.input.permission", id: "remote-tool-permissions", priority: -100 }, () => h("span", { className: "rw-meta", title: "工具使用所选机器登录用户的系统权限。工作区决定相对路径；文件侧栏限定在该目录内。" }, "目标用户权限")));
      for (const seat of ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"]) {
        ctx.slots.inject(seat, () => ctx.slots.register({ name: seat, id: "remote-directory", priority: -100 }, WorkspaceDirectoryFlow));
      }
      if (entry.get("remote") === "1") {
        openCreate();
        entry.delete("remote");
        const url = new URL(location.href); url.hash = entry.toString();
        history.replaceState(null, "", url.href);
      }
    }
    return { inject, apply };
  },
});

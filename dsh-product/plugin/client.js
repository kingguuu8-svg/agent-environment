window.__ModuleLoader__.load({
  id: "remote-dsh-workspaces",
  factory: (require) => {
    const React = require("react");
    const { Modal } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useSyncExternalStore } = React;
    const inject = ["connection", "sessions", "workspaces", "slots", "uiWorkspace", "layout", "sidebarRight", "inputTriggers"];

    class CloudConnectionError extends Error {
      constructor(cause) {
        const loginExpired = /HTTP (401|403)\b/.test(cause.message ?? "");
        super(loginExpired ?
          "云端登录已失效，请重新运行 dsh web --remote 打开入口。" :
          "暂时无法连接云端，请检查网络后重试。", { cause });
        this.loginExpired = loginExpired;
      }
    }

    function apply(ctx) {
      const clientId = (() => {
        // Keep this tab's controller on reload or plugin reload. A fresh tab gets a fresh identity,
        // including a tab that starts with a copied sessionStorage snapshot.
        try {
          const current = document.documentElement.dataset.remoteDshClient;
          if (/^[a-zA-Z0-9-]{16,80}$/.test(current ?? "")) return current;
          const key = "remote-dsh-controller";
          const previous = sessionStorage.getItem(key);
          const navigation = performance.getEntriesByType("navigation")[0]?.type;
          const identity = ["reload", "back_forward"].includes(navigation) && /^[a-zA-Z0-9-]{16,80}$/.test(previous ?? "") ? previous : crypto.randomUUID();
          sessionStorage.setItem(key, identity);
          return identity;
        } catch { return crypto.randomUUID(); }
      })();
      document.documentElement.dataset.remoteDshClient = clientId;
      // Native DSH remembers the last conversation across the browser. Keep this
      // tab's selection as well, so another project's window cannot redirect a reload.
      const selection = ctx.uiWorkspace.selection;
      const selectionKey = "remote-dsh-window-selection";
      try {
        const saved = JSON.parse(sessionStorage.getItem(selectionKey));
        if (saved && typeof saved === "object" && !Array.isArray(saved) && (saved.sessionId === undefined || typeof saved.sessionId === "string")) selection.set(saved);
      } catch {}
      const saveSelection = () => { try { sessionStorage.setItem(selectionKey, JSON.stringify(selection.getSnapshot())); } catch {} };
      saveSelection();
      ctx.effect(() => selection.subscribe(saveSelection), "remote: window conversation recovery");
      const entry = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
      const originMachine = entry.get("machine") ?? "cloud";
      const originWorkspace = entry.get("workspace");
      const label = originMachine === "cloud" ? "VPS4 Web" : `${originMachine} Web`;
      const originalCall = ctx.connection.rpc.call.bind(ctx.connection.rpc);
      const leases = new Map();
      const referenceTargets = new Map();
      const listeners = new Set();
      let createOpen = false;
      let creation = { busy: false, error: "", workspaceId: null };
      let creatingSession = null;
      let notice = null;
      let noticeTimer;
      const notifyCreation = () => { for (const listener of listeners) listener(); };
      const showNotice = (message, kind = "success") => {
        clearTimeout(noticeTimer); notice = { message, kind }; notifyCreation();
        noticeTimer = setTimeout(() => { notice = null; notifyCreation(); }, 6500);
      };
      ctx.effect(() => () => clearTimeout(noticeTimer), "remote: notice lifetime");
      const openCreate = () => { if (creatingSession) return; createOpen = true; creation = { busy: false, error: "", workspaceId: null }; notifyCreation(); };
      const closeCreate = () => { createOpen = false; notifyCreation(); };
      const api = async (method, request, signal) => {
        let result;
        try { result = await originalCall("/api", `remoteWorkspaces/${method}`, { args: { request } }, signal); }
        catch (error) {
          if (signal?.aborted || error.name === "AbortError") throw error;
          // Business failures arrive as RPC results. Only a transport failure
          // means the page cannot confirm the cloud's state or a submitted turn.
          throw new CloudConnectionError(error);
        }
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      };
      const control = async (sessionId, takeover = false, signal) => {
        const value = await api("control", { sessionId, clientId, label, takeover }, signal);
        leases.set(sessionId, value);
        return value;
      };
      const createInWorkspace = (workspaceId) => {
        if (creatingSession) return creatingSession;
        const existing = creation.workspaceId === workspaceId ? creation.sessionId : null;
        creation = { busy: true, error: "", workspaceId, sessionId: existing }; notifyCreation();
        creatingSession = (async () => {
          const sessionId = existing ?? await ctx.sessions.create({ workspaceId });
          creation = { ...creation, sessionId };
          await control(sessionId);
          ctx.uiWorkspace.openSession(sessionId);
          creation = { busy: false, error: "", workspaceId: null };
          return sessionId;
        })().catch((error) => {
          creation = { ...creation, busy: false, error: error.message, workspaceId };
          throw error;
        }).finally(() => {
          creatingSession = null;
          creation = { ...creation, busy: false }; notifyCreation();
        });
        return creatingSession;
      };
      const controlled = async (method, request, signal) => {
        const value = await control(request.sessionId, false, signal);
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
          } catch (error) {
            const message = error instanceof CloudConnectionError && endpoint === "session/prompt" ?
              error.message + " 发送结果尚未确认，草稿已保留。恢复后请先检查会话，再决定是否发送。" : error.message;
            return { ok: false, error: { code: "gateway/bad-request", message, details: {} } };
          }
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
        [class$="_heroWorkspaceRow"]:has(.rw-bar)>button{display:none}
        .rw-button{border:1px solid var(--dsw-alias-border-l4,#80808050);background:transparent;color:inherit;border-radius:8px;padding:7px 11px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px}
        .rw-button:hover,.rw-folder:hover,.rw-machine:hover,.rw-shortcut:hover{background:var(--dsw-alias-interactive-bg-hover,#80808018)}
        .rw-button:disabled,.rw-folder:disabled{opacity:.45;cursor:default}.rw-button:focus-visible,.rw-machine:focus-visible,.rw-folder:focus-visible,.rw-shortcut:focus-visible{outline:2px solid #729aff;outline-offset:2px}
        .rw-primary{background:#356be8;color:white;border-color:transparent}.rw-primary:hover{background:#2d5bcc}
        .rw-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#929699);line-height:1.6}.rw-pending{font-size:12px;color:#c68c21;max-width:350px}
        .rw-error{color:var(--dsw-alias-state-danger-primary,#d46161);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
        .rw-status{position:fixed;right:24px;bottom:70px;z-index:1100;background:var(--dsw-alias-bg-layer-2,#202124);color:var(--dsw-alias-label-primary,#eee);border:1px solid #80808050;border-radius:12px;padding:13px 16px;display:flex;align-items:center;gap:10px;max-width:min(480px,calc(100vw - 48px));box-shadow:0 8px 24px #0003;font-size:13px;line-height:1.5}
        .rw-dialog{width:720px!important;max-width:100%;max-height:100%;overflow:hidden!important;display:flex!important;flex-direction:column;gap:0!important;padding:24px!important;font-family:inherit;color:var(--dsw-alias-label-primary,#eee)}
        .rw-dialog-body{overflow:auto;min-height:0;padding-right:2px}.rw-dialog-heading,.rw-description,.rw-selection,.rw-footer{flex-shrink:0}.rw-dialog h2{margin:0;font-size:20px;line-height:1.5;font-weight:550}.rw-dialog-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px}.rw-description{font-size:13px;color:var(--dsw-alias-label-secondary,#999);margin:0 0 20px;line-height:1.6}
        .rw-row{display:flex;align-items:center;gap:8px;margin-bottom:12px}.rw-row label{font-size:13px}.rw-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l4,#80808060);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,#80808012);color:inherit;font:inherit;padding:9px 11px;font-size:13px;outline:none}.rw-input:focus{border-color:#729aff}
        .rw-folders{height:clamp(100px,20vh,180px);overflow:auto;border:1px solid var(--dsw-alias-border-l4,#80808040);border-radius:10px;padding:6px}.rw-folder{display:flex;gap:10px;align-items:center;width:100%;border:0;background:transparent;color:inherit;padding:9px 11px;text-align:left;border-radius:6px;cursor:pointer;font:inherit;font-size:13px}.rw-folder span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rw-folder .rw-chevron{margin-left:auto;color:var(--dsw-alias-label-tertiary,#888)}
        .rw-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-top:16px;margin-top:16px;border-top:1px solid var(--dsw-alias-border-l4,#80808040)}.rw-footer-actions{display:flex;gap:8px;flex-shrink:0}.rw-empty{padding:30px;text-align:center;color:var(--dsw-alias-label-secondary,#999);font-size:13px;line-height:1.7}
        .rw-icon{width:16px;height:16px;flex:none;display:inline-block}.rw-section-label{font-size:12px;color:var(--dsw-alias-label-secondary,#999);margin:14px 0 8px;display:block}
        .rw-machines{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.rw-machine{border:1px solid var(--dsw-alias-border-l4,#80808050);border-radius:10px;color:inherit;background:transparent;cursor:pointer;padding:12px;text-align:left;min-width:0}.rw-machine[aria-pressed=true]{background:#356be810;border-color:#648cdb}.rw-machine-heading{display:flex;align-items:center;gap:7px;font:inherit;font-size:13px;font-weight:500}.rw-machine-host{font-size:11px;color:var(--dsw-alias-label-secondary,#999);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:5px}.rw-machine:disabled{opacity:.6;cursor:default}
        .rw-shortcuts{display:flex;gap:6px;flex-wrap:wrap;max-height:90px;overflow:auto;margin-bottom:14px}.rw-shortcut{padding:6px 9px;border:1px solid var(--dsw-alias-border-l4,#80808050);border-radius:7px;color:inherit;background:transparent;cursor:pointer;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rw-shortcut[aria-pressed=true]{border-color:#648cdb;background:#356be810}
        .rw-selection{background:var(--dsw-alias-interactive-bg-hover,#80808012);border-radius:10px;padding:12px;margin:12px 0 0}.rw-selection-top{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;margin-bottom:5px}.rw-full-path{font-size:12px;line-height:1.6;overflow-wrap:anywhere;display:block;color:var(--dsw-alias-label-secondary,#aaa)}.rw-dot{width:7px;height:7px;border-radius:50%;background:#979a9e;display:inline-block;flex:none}.rw-dot[data-status=online]{background:#65b88a}.rw-dot[data-status=unavailable],.rw-dot[data-status=cloud-offline]{background:#d47b6e}.rw-dot[data-status=checking]{background:#d7ad65}
        .rw-target{max-width:300px;border-radius:8px;padding:6px 9px;gap:7px;background:var(--dsw-alias-interactive-bg-hover,#80808012)}.rw-target-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.rw-target-status{font-size:11px;color:var(--dsw-alias-label-secondary,#999);white-space:nowrap}.rw-control{font-size:11px;color:var(--dsw-alias-label-secondary,#999);white-space:nowrap}.rw-connection-warning{border:1px solid #c68c2140;background:#c68c2108;border-radius:10px;padding:12px;margin-bottom:14px;line-height:1.6;font-size:13px}.rw-details{font-size:12px;color:var(--dsw-alias-label-secondary,#999);margin-top:14px;line-height:1.7}.rw-details summary{cursor:pointer}.rw-details p{margin:8px 0}.rw-tools{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.rw-tool{border:1px solid var(--dsw-alias-border-l4,#80808040);border-radius:5px;padding:2px 7px;font-size:11px}
        @media(max-width:640px){.rw-dialog{padding:18px!important}.rw-machines{grid-template-columns:repeat(2,minmax(0,1fr))}.rw-footer{align-items:stretch;flex-direction:column}.rw-footer-actions{justify-content:flex-end}.rw-folders{height:120px}.rw-target{max-width:235px}.rw-target-status,.rw-control{display:none}.rw-row{flex-wrap:wrap}}
      `;
      document.head.append(style);
      ctx.effect(() => () => style.remove(), "remote: styles");

      const shortTarget = (target) => `${target.hostname ?? target.machine} · ${target.workspace.split(/[\\/]/).filter(Boolean).at(-1) || "/"}`;
      const icon = (name) => h("svg", { className: "rw-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: {
        folder: "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
        machine: "M3 4h18v12H3ZM8 21h8M12 16v5",
        cloud: "M7 18h11a4 4 0 0 0 .7-8 6 6 0 0 0-11.5-2A5 5 0 0 0 7 18Z",
        chevron: "m9 5 7 7-7 7",
        copy: "M8 8h12v12H8ZM16 8V3H3v13h5",
      }[name] }));
      const copyPath = async (path) => {
        try { await navigator.clipboard.writeText(path); showNotice("工作区路径已复制"); }
        catch { showNotice("复制失败，可以选中完整路径手动复制。", "error"); }
      };

      function DeviceSetupDialog({ onClose, onConnected }) {
        const [targetOs, setTargetOs] = useState(/Win/i.test(navigator.platform) ? "windows" : /Mac/i.test(navigator.platform) ? "mac" : "linux");
        const [installer, setInstaller] = useState(null);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const [now, setNow] = useState(Date.now());
        const [feedback, setFeedback] = useState(null);
        const [statusError, setStatusError] = useState("");
        const [returning, setReturning] = useState(false);
        const waiting = useRef(false);
        const lifetime = useRef();
        const refreshStatus = useRef(() => {});
        const leaving = useRef(false);
        useEffect(() => {
          const abort = new AbortController(); lifetime.current = abort;
          const timer = setInterval(() => setNow(Date.now()), 10000);
          return () => { abort.abort(); clearInterval(timer); };
        }, []);
        useEffect(() => {
          if (!installer?.pairingId) return;
          let disposed = false, checking = false, finished = false, timer;
          const abort = new AbortController();
          const poll = async () => {
            if (disposed || checking || finished) return;
            clearTimeout(timer);
            if (document.visibilityState !== "hidden") {
              checking = true;
              try {
                const value = await api("deviceInstallerStatus", { pairingId: installer.pairingId }, abort.signal);
                if (!disposed) {
                  setFeedback(value); setStatusError("");
                  finished = value.phase === "expired" || value.connection?.status === "online";
                }
              } catch (failure) { if (!disposed) setStatusError(failure.message); }
              finally { checking = false; }
            }
            if (!disposed && !finished) timer = setTimeout(poll, 3000);
          };
          refreshStatus.current = poll;
          const visible = () => { if (document.visibilityState !== "hidden") poll(); };
          document.addEventListener("visibilitychange", visible);
          poll();
          return () => { disposed = true; abort.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
        }, [installer?.pairingId]);
        const leave = async (selectDevice = false) => {
          if (leaving.current || waiting.current) return;
          leaving.current = true; setReturning(true); setError("");
          try { await (selectDevice ? onConnected(feedback.machine, lifetime.current.signal) : onClose(lifetime.current.signal)); }
          catch (failure) { if (!lifetime.current.signal.aborted) setError(failure.message); }
          finally { leaving.current = false; if (!lifetime.current.signal.aborted) setReturning(false); }
        };
        const download = async () => {
          if (waiting.current || leaving.current) return;
          waiting.current = true; setBusy(true); setError("");
          try {
            const value = installer && installer.expiresAt > Date.now() ? installer : await api("deviceInstaller", { platform: targetOs }, lifetime.current.signal);
            if (lifetime.current.signal.aborted) return;
            if (value.pairingId !== installer?.pairingId) { setFeedback(null); setStatusError(""); }
            setInstaller(value); setNow(Date.now());
            const data = value.encoding === "base64" ? Uint8Array.from(atob(value.content), (char) => char.charCodeAt(0)) : value.content;
            const url = URL.createObjectURL(new Blob([data], { type: value.encoding === "base64" ? "application/zip" : "text/x-shellscript;charset=utf-8" }));
            const link = document.createElement("a"); link.href = url; link.download = value.filename; link.hidden = true;
            document.body.append(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
          } catch (failure) { if (!lifetime.current.signal.aborted) setError(failure.message); }
          finally { waiting.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
        };
        const remaining = installer ? Math.max(0, Math.ceil((installer.expiresAt - now) / 60000)) : null;
        const ready = feedback?.phase === "registered" && feedback.connection?.status === "online";
        const expired = feedback?.phase === "expired" || remaining === 0 && feedback?.phase !== "registered";
        const progress = ready ? `${feedback.machine.label} 已连接，可以选择工作区。` : feedback?.phase === "registered" ?
          feedback.connection?.status === "unavailable" ? `${feedback.machine.label} 已注册，工具连接暂未就绪。正在自动重试。` : `${feedback.machine.label} 已注册，正在准备工具连接…` :
          expired ? "安装器已过期，请重新生成并下载。" : feedback?.phase === "registering" ? "设备正在向云端注册…" : "等待在新机器上运行安装器…";
        return h(Modal, { open: true, headless: true, title: "接入新设备", onClose: () => leave(), className: "rw-dialog" },
          h("div", { className: "rw-dialog-heading" }, h("h2", null, "接入新设备"), h("button", { type: "button", className: "rw-button", disabled: busy || returning, "aria-label": "返回工作区选择", onClick: () => leave() }, "×")),
          h("p", { className: "rw-description" }, "选择新机器的操作系统，下载安装器，共享云端会话并提供本机工具。"),
          h("div", { className: "rw-dialog-body" },
            h("div", { className: "rw-machines", role: "group", "aria-label": "目标操作系统" }, ...[{ id: "linux", label: "Linux", hint: "systemd 用户服务" }, { id: "mac", label: "macOS", hint: "Intel / Apple Silicon · 预览" }, { id: "windows", label: "Windows", hint: "Windows 10 / 11 · 预览" }].map((item) => h("button", { key: item.id, type: "button", className: "rw-machine", "aria-pressed": targetOs === item.id, disabled: busy || returning, onClick: () => { if (item.id === targetOs) return; setTargetOs(item.id); setInstaller(null); setFeedback(null); setStatusError(""); setError(""); } }, h("span", { className: "rw-machine-heading" }, item.label), h("span", { className: "rw-machine-host" }, item.hint)))),
            h("ol", { className: "rw-setup-steps", style: { paddingLeft: "22px", fontSize: "14px", lineHeight: 1.9 } },
              h("li", null, "下载专属安装器，放到准备接入的新机器。"),
              targetOs === "windows" ? h("li", null, "解压 ZIP，双击其中的 ", h("code", null, "dsh-connect.cmd"), "。") : h("li", null, "在文件所在目录打开终端，执行：", h("pre", { style: { padding: "12px", background: "var(--dsw-alias-interactive-bg-hover,#80808012)", borderRadius: "8px", overflowWrap: "anywhere", whiteSpace: "pre-wrap" } }, targetOs === "mac" ? "bash dsh-connect-mac.command" : "bash dsh-connect-linux.sh")),
              h("li", null, "安装器会自动配对、准备依赖、建立后台连接并打开页面。以后在项目目录运行 ", h("code", null, "dsh web --remote"), "。")),
            h("p", { className: "rw-meta" }, targetOs === "linux" ? "需要 systemd 用户服务；缺少系统依赖时会请求 sudo。运行时安装在用户目录。" : targetOs === "mac" ? "后台连接使用 launchd；缺少 Python 时会请求管理员密码安装官方运行时。" : "后台连接随用户登录启动。自动安装 Python、Node.js 和 Git Bash；缺少 OpenSSH 客户端时需以管理员运行一次。"),
            targetOs !== "linux" ? h("p", { className: "rw-meta" }, `${targetOs === "mac" ? "macOS" : "Windows"} 安装包为预览版，尚未完成对应系统的真机安装验证。`) : null,
            h("p", { className: "rw-meta" }, "安装器仅用于一台自己的设备，有效期 15 分钟。文件包含临时配对凭据，请保留在自己的设备上。安装失败可以重跑，重复安装沿用原设备。"),
            installer ? h("div", { className: "rw-selection" },
              h("div", { role: "status" }, h("span", { className: "rw-dot", "data-status": ready ? "online" : expired || statusError ? "unavailable" : "checking", style: { marginRight: "8px" } }), progress),
              remaining && feedback?.phase !== "registered" ? h("p", { className: "rw-meta" }, `约 ${remaining} 分钟内有效。此页面会自动检查接入进度。`) : null,
              feedback?.connection?.error ? h("details", { className: "rw-details" }, h("summary", null, "查看连接原因"), h("div", { className: "rw-error" }, feedback.connection.error)) : null,
              statusError ? h("div", { role: "alert", className: "rw-error" }, "暂时无法检查接入进度：", statusError, " ", h("button", { type: "button", className: "rw-button", onClick: () => refreshStatus.current() }, "重新检查")) : null,
              h("p", { className: "rw-meta" }, "已经接入过的机器可直接返回工作区选择，重跑安装会沿用原设备。")) : null,
            error ? h("p", { role: "alert", className: "rw-error" }, error) : null),
          h("div", { className: "rw-footer" }, h("span", { className: "rw-meta" }, "Agent、模型配置和记录继续保存在 VPS4。"),
            h("div", { className: "rw-footer-actions" }, h("button", { type: "button", className: "rw-button", disabled: busy || returning, onClick: () => leave() }, returning ? "正在返回…" : "返回工作区选择"),
              ready ? h("button", { type: "button", className: "rw-button rw-primary", disabled: returning, onClick: () => leave(true), "data-modal-autofocus": true }, "选择此设备的工作区") :
                h("button", { type: "button", className: "rw-button rw-primary", disabled: busy || returning, onClick: download, "data-modal-autofocus": true }, busy ? "正在生成…" : expired ? "重新生成并下载" : installer ? "再次下载" : "下载安装器"))));
      }

      function DirectoryDialog({ title, initial, busy: ownerBusy, onChoose, onCancel, actionLabel = "选择此目录", switching = false, canChoose = true, onHandoff, connection, onProbe }) {
        const [catalog, setCatalog] = useState(null);
        const [machine, setMachine] = useState(initial?.machine ?? originMachine);
        const [path, setPath] = useState(initial?.workspace ?? originWorkspace ?? "");
        const [listing, setListing] = useState(null);
        const [loading, setLoading] = useState(true);
        const [saving, setSaving] = useState(false);
        const [error, setError] = useState("");
        const [hidden, setHidden] = useState(false);
        const [filter, setFilter] = useState("");
        const [setupOpen, setSetupOpen] = useState(false);
        const lifetime = useRef();
        const catalogRequest = useRef();
        const generation = useRef(0);
        const committing = useRef(false);
        const lastPaths = useRef(new Map());
        const busy = saving || ownerBusy;
        const machines = catalog?.machines ?? [];
        const chosenMachine = machines.find((item) => item.id === machine);
        const scan = async (selectedMachine, directory) => {
          const ticket = ++generation.current;
          lifetime.current?.abort();
          const abort = new AbortController(); lifetime.current = abort;
          setLoading(true); setError(""); setListing(null); setFilter(""); setPath(directory ?? "");
          try {
            const value = await api("browse", { machine: selectedMachine, ...(directory ? { path: directory } : {}) }, abort.signal);
            if (ticket === generation.current && !abort.signal.aborted) {
              setListing(value); setPath(value.absolutePath);
              lastPaths.current.set(selectedMachine, value.absolutePath);
            }
          } catch (failure) { if (ticket === generation.current && !abort.signal.aborted) setError(failure.message); }
          finally { if (ticket === generation.current) setLoading(false); }
        };
        const startingDirectory = (selected) => lastPaths.current.get(selected.id)
          ?? (initial?.machine === selected.id ? initial.workspace : null)
          ?? (originMachine === selected.id ? originWorkspace : null)
          ?? selected.workspace;
        const loadCatalog = () => {
          catalogRequest.current?.abort();
          const controller = new AbortController();
          catalogRequest.current = controller;
          setLoading(true); setError("");
          api("catalog", {}, controller.signal).then((value) => {
            if (controller.signal.aborted) return;
            setCatalog(value);
            const chosen = value.machines.find((item) => item.id === machine) ?? value.machines[0];
            if (!chosen) throw new Error("还没有可用机器，请先接入设备。");
            setMachine(chosen.id);
            scan(chosen.id, chosen.id === machine ? path || startingDirectory(chosen) : startingDirectory(chosen));
          }).catch((failure) => { if (!controller.signal.aborted) { setError(failure.message); setLoading(false); } });
        };
        useEffect(() => {
          loadCatalog();
          return () => { catalogRequest.current?.abort(); lifetime.current?.abort(); generation.current++; };
        }, []);
        useEffect(() => {
          if (connection && connection.status !== "cloud-offline" && !catalog && !loading && error) { loadCatalog(); return; }
          if (connection?.status === "online" && catalog && !listing && !loading && error && machine === initial?.machine && path === initial?.workspace) scan(machine, path);
        }, [connection?.status]);
        const changedPath = listing && path !== listing.absolutePath;
        const sameWorkspace = switching && machine === initial?.machine && listing?.absolutePath === initial?.workspace;
        const takingOver = !canChoose && !!onHandoff;
        const canCommit = canChoose || takingOver;
        const commit = async () => {
          if (!listing || busy || loading || changedPath || !canCommit || sameWorkspace || committing.current) return;
          committing.current = true;
          setSaving(true); setError("");
          try { await (takingOver ? onHandoff : onChoose)({ machine, workspace: listing.absolutePath }); }
          catch (failure) { committing.current = false; setError(failure.message); setSaving(false); }
        };
        const cancel = () => { if (!busy) onCancel(); };
        const parent = (listing?.absolutePath.replaceAll("\\", "/").replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/").replace(/^([A-Za-z]:)$/, "$1/");
        const saved = new Map((catalog?.savedWorkspaces ?? []).filter((item) => item.machine === machine).map((item) => [item.workspace, item]));
        if (initial?.machine === machine && !saved.has(initial.workspace)) saved.set(initial.workspace, initial);
        const entryDirectory = switching && machine === originMachine && originWorkspace && (initial?.machine !== machine || initial.workspace !== originWorkspace) ? originWorkspace : null;
        if (entryDirectory) saved.delete(entryDirectory);
        const directories = (listing?.entries ?? []).filter((item) => item.type === "directory" && (hidden || !item.name.startsWith(".")));
        const visibleDirectories = directories.filter((item) => item.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
        const toolLabels = { read: "读取", write: "写入", edit: "精确编辑", bash: "运行命令", grep: "搜索内容", find: "查找文件", ls: "列目录" };
        const returnToPicker = async (selected, signal) => {
          const value = await api("catalog", {}, signal);
          if (signal.aborted) return;
          if (selected && !value.machines.some((item) => item.id === selected.id)) throw new Error("设备暂时没有出现在工作环境中，请稍后重试。");
          setCatalog(value); setSetupOpen(false);
          if (selected) { setMachine(selected.id); scan(selected.id, selected.workspace); }
        };
        if (setupOpen) return h(DeviceSetupDialog, { onClose: (signal) => returnToPicker(null, signal), onConnected: returnToPicker });
        return h(Modal, { open: true, headless: true, title, onClose: cancel, className: "rw-dialog" },
          h("div", { className: "rw-dialog-heading" }, h("h2", null, title), h("button", { type: "button", className: "rw-button", disabled: busy, "aria-label": "关闭", "data-modal-autofocus": true, onClick: cancel }, "×")),
          h("p", { className: "rw-description" }, switching ? "切换工具的执行位置，同一会话继续使用原有历史。" : "选一个工作区开始。Agent 和会话记录保存在 VPS4。"),
          h("div", { className: "rw-dialog-body" },
          connection?.status === "cloud-offline" ? h("div", { className: "rw-connection-warning", role: "status" },
            h("strong", null, connection.loginExpired ? "云端登录已失效" : "页面与云端的连接已中断"),
            h("div", { className: "rw-meta" }, connection.loginExpired ? connection.error : "正在自动重连。恢复连接后才能检查机器和切换工作区。"),
            onProbe && !connection.loginExpired ? h("button", { className: "rw-button", type: "button", disabled: busy, onClick: onProbe }, "重连云端") : null) :
          connection?.status === "unavailable" ? h("div", { className: "rw-connection-warning", role: "status" },
            h("strong", null, "当前会话的工作区暂时无法连接"),
            h("div", { className: "rw-meta" }, "可以重新检查，或选择其他机器。会话记录仍在云端。"),
            onProbe ? h("button", { className: "rw-button", type: "button", disabled: busy, onClick: onProbe }, "重新检查连接") : null,
            connection.error ? h("details", { className: "rw-details" }, h("summary", null, "查看连接原因"), h("div", { className: "rw-error" }, connection.error)) : null) :
            connection?.status === "checking" ? h("p", { className: "rw-meta", role: "status" }, "正在检查当前工作区连接…") : null,
          h("div", { className: "rw-machines", role: "group", "aria-label": "选择机器" }, machines.map((item) => h("button", {
            key: item.id, type: "button", className: "rw-machine", disabled: busy, "aria-pressed": machine === item.id,
            "aria-label": item.label + (item.hostname ? " · " + item.hostname : ""),
            onClick: () => { setMachine(item.id); scan(item.id, startingDirectory(item)); },
          }, h("span", { className: "rw-machine-heading" }, icon(item.id === "cloud" ? "cloud" : "machine"), item.label),
            h("span", { className: "rw-machine-host", title: item.hostname ?? item.id }, item.hostname ?? item.id)))),
          entryDirectory ? h(React.Fragment, null, h("span", { className: "rw-section-label" }, "本次终端目录"), h("div", { className: "rw-shortcuts", "aria-label": "本次终端目录" },
            h("button", { type: "button", className: "rw-shortcut", title: entryDirectory, disabled: busy || loading, "aria-pressed": listing?.absolutePath === entryDirectory,
              "aria-label": "选择本次终端目录", onClick: () => scan(machine, entryDirectory) }, entryDirectory.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "/"))) : null,
          saved.size ? h(React.Fragment, null, h("span", { className: "rw-section-label" }, "已有工作区"), h("div", { className: "rw-shortcuts", "aria-label": "已有工作区" },
            [...saved.values()].map((item) => h("button", { key: item.workspace, type: "button", className: "rw-shortcut", title: item.workspace, disabled: busy, "aria-pressed": listing?.absolutePath === item.workspace,
              onClick: () => scan(machine, item.workspace) }, item.workspace.split("/").filter(Boolean).at(-1) || "/")))) : null,
          h("span", { className: "rw-section-label" }, "工作区目录"),
          h("form", { className: "rw-row", onSubmit: (event) => { event.preventDefault(); if (!busy && catalog) scan(machine, path); } },
            h("input", { "aria-label": "工作区目录", className: "rw-input", value: path, disabled: busy || !catalog, placeholder: "输入完整目录，按 Enter 前往", onChange: (event) => setPath(event.target.value) }),
            h("button", { type: "submit", className: "rw-button", disabled: busy || !catalog }, "前往")),
          h("div", { className: "rw-row" },
            h("button", { type: "button", className: "rw-button", disabled: busy || loading || !listing, onClick: () => scan(machine, listing.home) }, "主目录"),
            h("button", { type: "button", className: "rw-button", disabled: busy || loading || !listing || listing.absolutePath === "/", onClick: () => scan(machine, parent) }, "上一级"),
            h("label", { className: "rw-meta", style: { marginLeft: "auto" } }, h("input", { type: "checkbox", checked: hidden, disabled: busy, onChange: (event) => setHidden(event.target.checked) }), " 显示隐藏目录")),
          h("input", { className: "rw-input", style: { width: "100%", boxSizing: "border-box", marginBottom: "8px" }, "aria-label": "筛选子目录", placeholder: "筛选子目录…", value: filter, disabled: busy || !listing, onChange: (event) => setFilter(event.target.value) }),
          h("div", { className: "rw-folders", "aria-label": "远端目录", "aria-busy": loading },
            loading ? h("div", { className: "rw-empty", role: "status" }, "正在读取机器目录…") : !listing ? h("div", { className: "rw-empty" }, error ? "暂时无法打开这个目录" : "请选择机器与目录") :
            visibleDirectories.length ? visibleDirectories.map((item) => h("button", { key: item.name, className: "rw-folder", type: "button", disabled: busy, onClick: () => scan(machine, listing.absolutePath.replace(/\/$/, "") + "/" + item.name) },
              icon("folder"), h("span", null, item.name), h("span", { className: "rw-chevron" }, icon("chevron")))) :
            h("div", { className: "rw-empty" }, filter ? "没有匹配的子目录，试试其他名称。" : "此目录下没有可显示的子目录。仍可使用当前目录。")),
          error ? h("div", { className: "rw-connection-warning", role: "alert" }, h("span", null, connection?.status === "cloud-offline" ? "恢复云端连接后，机器和目录会重新载入。" : !catalog ? "暂时无法读取机器列表，可以在此重试。" : "目录读取或选择失败。可以修改路径，或重新尝试。"),
            h("button", { className: "rw-button", type: "button", style: { marginLeft: "8px" }, disabled: busy || loading, onClick: () => catalog ? scan(machine, path) : loadCatalog() }, "重试"),
            chosenMachine?.workspace && path !== chosenMachine.workspace ? h("button", { className: "rw-button", type: "button", style: { marginLeft: "8px" }, title: chosenMachine.workspace, disabled: busy || loading,
              onClick: () => scan(machine, chosenMachine.workspace) }, "打开设备默认目录") : null,
            h("details", { className: "rw-details" }, h("summary", null, "查看原因"), h("div", { className: "rw-error" }, error))) : null,
          h("details", { className: "rw-details" }, h("summary", null, "Agent 能访问什么"),
            h("p", null, "默认文件与命令工具使用所选工作区。Agent 也能指定访问其他已接入机器和云端目录。"),
            h("div", { className: "rw-tools" }, (catalog?.tools ?? []).map((name) => h("span", { key: name, className: "rw-tool", title: name }, toolLabels[name] ?? name))),
            catalog?.services?.length ? h("p", null, "扩展服务：" + catalog.services.map((service) => service.id + (service.tools.length ? "（" + service.tools.length + " 个工具）" : "（按需发现工具）")).join("、")) : null),
          ),
          listing ? h("div", { className: "rw-selection" },
            h("div", { className: "rw-selection-top" }, h("span", null, h("span", { className: "rw-dot", "data-status": "online", style: { marginRight: "7px" } }), (sameWorkspace ? "当前：" : "将使用：") + shortTarget({ machine, hostname: chosenMachine?.hostname, workspace: listing.absolutePath })),
              h("button", { className: "rw-button", type: "button", "aria-label": "复制工作区路径", onClick: () => copyPath(listing.absolutePath) }, icon("copy"), "复制路径")),
            h("code", { className: "rw-full-path" }, listing.absolutePath)) : null,
          changedPath ? h("p", { className: "rw-meta", role: "status" }, "目录已修改，按 Enter 或“前往”载入后再选择。") : null,
          h("div", { className: "rw-footer" },
            h("div", null, h("span", { className: "rw-meta" }, takingOver ? "确认后，此窗口接管输入；原窗口继续查看。执行中的任务保留原工作区。" : !canChoose ? "查看模式：接管输入后可切换工作区。" : switching ? "模型提示词和文件侧栏随工作区更新。" : listing?.truncated ? "目录较多，可输入完整路径前往。" : "记录在云端，文件留在所选机器。"),
              h("button", { type: "button", className: "rw-button", style: { marginTop: "8px", display: "flex" }, disabled: busy, onClick: () => setSetupOpen(true) }, "接入新设备")),
            h("div", { className: "rw-footer-actions" },
              h("button", { type: "button", className: "rw-button", disabled: busy, onClick: cancel }, "取消"),
              h("button", { type: "button", className: "rw-button rw-primary", disabled: busy || loading || !listing || changedPath || !canCommit || sameWorkspace, onClick: commit }, busy ? takingOver ? "正在接管并准备工作区…" : "正在准备工作区…" : sameWorkspace ? "当前工作区" : takingOver ? "接管并切换" : actionLabel)))
        );
      }

      function NewSessionFlow() {
        const open = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => createOpen);
        const status = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => creation);
        const message = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => notice);
        const toast = message ? h("div", { className: "rw-status", role: message.kind === "error" ? "alert" : "status" }, message.message) : null;
        const progress = status.busy || status.error ? h("div", { className: "rw-status", role: status.error ? "alert" : "status" },
          h("span", { className: status.error ? "rw-error" : "rw-meta" }, status.error ? `新建会话失败：${status.error}` : "正在新建会话…"),
          status.error ? h("button", { className: "rw-button", onClick: () => createInWorkspace(status.workspaceId).catch(() => {}) }, "重试") : null,
          status.error ? h("button", { className: "rw-button", onClick: () => { creation = { busy: false, error: "", workspaceId: null }; notifyCreation(); } }, "关闭") : null) : null;
        if (!open) return progress ?? toast;
        return h(React.Fragment, null, toast, h(DirectoryDialog, { title: "新建会话", actionLabel: "在此新建会话", onCancel: closeCreate, onChoose: async (chosen) => {
          const picked = await api("pick", chosen);
          // Use DSH's controller so its local workspace snapshot receives the
          // authoritative row before session selection and startup recovery.
          const group = await ctx.workspaces.create({ path: picked.cwd });
          await createInWorkspace(group.workspaceId);
          closeCreate();
        } }));
      }
      function WorkspaceDirectoryFlow({ open, busy, onPicked, onCancel, onError }) {
        if (!open) return null;
        return h(DirectoryDialog, { title: "添加工作区", actionLabel: "添加工作区", busy, onCancel, onChoose: async (chosen) => {
          const picked = await api("pick", chosen);
          onPicked(picked.cwd);
        } });
      }
      function WorkspaceHeader({ sessionId, useProjection }) {
        const binding = useProjection("remoteBinding");
        const [snapshot, setSnapshot] = useState(null);
        const [choosing, setChoosing] = useState(false);
        const [error, setError] = useState(null);
        const [probing, setProbing] = useState(null);
        const previousTarget = useRef();
        const activeSession = useRef(sessionId);
        const refreshNow = useRef(() => {});
        const probeNow = useRef(() => {});
        activeSession.current = sessionId;
        const state = snapshot && snapshot.sessionId === sessionId ? snapshot.value : null;
        const effective = state && (!binding || state.revision >= binding.revision) ? state : binding;
        const current = effective?.current;
        const setView = (value) => {
          leases.set(sessionId, value);
          if (activeSession.current !== sessionId) return;
          setSnapshot((previous) => {
            if (previous && previous.sessionId === sessionId && (previous.value.revision > value.revision || JSON.stringify(previous.value) === JSON.stringify(value))) return previous;
            return { sessionId, value };
          });
        };
        useEffect(() => {
          setChoosing(false); setError(null);
          if (!sessionId) return;
          let disposed = false, refreshing = false, timer;
          const abort = new AbortController();
          const refresh = async () => {
            if (disposed || refreshing) return;
            refreshing = true;
            try {
              let value = await api("get", { sessionId, clientId }, abort.signal);
              if (!value.control && !disposed) value = await control(sessionId);
              if (!disposed) { setView(value); setError(null); }
            } catch (failure) { if (!disposed) setError(failure); }
            finally { refreshing = false; }
          };
          const poll = async () => {
            if (document.visibilityState !== "hidden") await refresh();
            if (!disposed) timer = setTimeout(poll, 2000);
          };
          refreshNow.current = refresh;
          const visible = () => { if (document.visibilityState !== "hidden") refresh(); };
          document.addEventListener("visibilitychange", visible);
          poll();
          return () => { disposed = true; abort.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
        }, [sessionId]);
        useEffect(() => {
          if (!current?.id) return;
          const target = current.id;
          let disposed = false, checking = false;
          const abort = new AbortController();
          const check = async () => {
            if (disposed || checking) return;
            checking = true; setProbing(target);
            try {
              await api("probe", { target }, abort.signal);
              const value = await api("get", { sessionId, clientId }, abort.signal);
              if (!disposed) { setView(value); setError(null); }
            } catch (failure) { if (!disposed) setError(failure); }
            finally { checking = false; if (!disposed) setProbing(null); }
          };
          probeNow.current = check;
          if (document.visibilityState !== "hidden") check();
          const visible = () => { if (document.visibilityState !== "hidden") check(); };
          const timer = setInterval(visible, 30000);
          document.addEventListener("visibilitychange", visible);
          return () => { disposed = true; abort.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
        }, [current?.id, sessionId]);
        useEffect(() => {
          if (!current) return;
          const previous = referenceTargets.get(sessionId);
          referenceTargets.set(sessionId, current.id);
          if (!previous || previous === current.id) return;
          const scope = ctx.sessions.scope(sessionId);
          if (scope) {
            const trigger = ctx.inputTriggers.sessionOf(scope);
            if (trigger.menu.getSnapshot().hit?.trigger === "@") trigger.dismiss();
          }
        }, [current?.id, sessionId]);
        useEffect(() => {
          // A switch RPC can arrive before its native projection. FilesBody reads
          // that projection when it seeds a tab, so reopen only after it catches up.
          if (!current || binding?.current?.id !== current.id) return;
          const previous = previousTarget.current;
          if (previous && previous.sessionId === sessionId && previous.id !== current.id) {
            const sidebar = ctx.sidebarRight;
            const visible = sidebar.isExpanded();
            for (const tab of sidebar.tabsIn(sessionId)) {
              if (["files", "text", "document", "terminal"].includes(tab.kind)) sidebar.closeIn(sessionId, tab.id);
            }
            if (visible) sidebar.openTab("files");
            showNotice("已切换至 " + shortTarget(current) + "。下一条消息使用此工作区。");
          }
          previousTarget.current = { sessionId, id: current.id };
        }, [current?.id, binding?.current?.id, sessionId]);
        if (!current) return null;
        const mine = state?.control?.mine;
        const pending = effective.pending;
        const connection = state?.current?.id === current.id ? state.connection : null;
        const cloudUnavailable = error instanceof CloudConnectionError;
        const availability = cloudUnavailable ? "cloud-offline" : probing === current.id ? "checking" : connection?.status ?? "unknown";
        const statusLabel = { online: "已连接", unavailable: "工作区不可用", checking: "检查中", unknown: "待检查", "cloud-offline": error?.loginExpired ? "登录已失效" : "云端断线" }[availability];
        const selectWorkspace = async (chosen, takeover = false) => {
          const request = { sessionId, revision: effective.revision, ...chosen };
          const value = takeover ? await api("switch", { ...request, takeover: true, clientId, label }) : await controlled("switch", request);
          setView(value); setChoosing(false);
          if (value.pending) showNotice((takeover ? "已接管输入。" : "") + "已安排切换。当前任务继续在原工作区执行，结束后切换至 " + shortTarget(value.pending) + "。");
          else if (takeover) showNotice("已接管输入并切换至 " + shortTarget(value.current) + "，可以继续同一条会话。");
        };
        return h("div", { className: "rw-bar", "data-remote-machine": current.machine, "data-remote-workspace": current.workspace },
          h("button", { type: "button", className: "rw-button rw-target", "aria-label": "工作环境：" + shortTarget(current), title: current.workspace + "\n点击查看机器、目录和连接，或切换工作区。", onClick: () => setChoosing(true) },
            h("span", { className: "rw-dot", "data-status": availability }), h("span", { className: "rw-target-label" }, shortTarget(current)), h("span", { className: "rw-target-status" }, statusLabel), h("span", { "aria-hidden": true }, "⌄")),
          mine ? h("span", { className: "rw-control", title: cloudUnavailable ? "未发送内容保留在当前浏览器。连接恢复后先检查会话，再决定是否发送。" : "会话记录保存在 VPS4，此窗口可以提交输入。" }, cloudUnavailable ? "草稿保留 · 等待重连" : "云端记录 · 可输入") :
            h("button", { type: "button", className: "rw-button", disabled: cloudUnavailable, onClick: async () => {
              try { setView(await control(sessionId, true)); setError(null); showNotice("已接管输入，可以继续这条会话。"); } catch (failure) { setError(failure); }
            } }, "接管输入"),
          !mine && state?.control ? h("span", { className: "rw-meta", style: { maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: state.control.label }, "查看模式 · " + state.control.label) : null,
          pending ? h("span", { className: "rw-pending", title: pending.workspace }, "当前任务结束后切换至 " + shortTarget(pending), mine ? h("button", { type: "button", className: "rw-button", onClick: async () => {
            try { setView(await controlled("discardSwitch", { sessionId })); showNotice("已撤回待切换工作区。"); } catch (failure) { setError(failure); }
          } }, "撤回") : null) : null,
          ["unavailable", "cloud-offline"].includes(availability) && !error?.loginExpired ? h("button", { className: "rw-button", type: "button", onClick: () => { refreshNow.current(); probeNow.current(); } }, cloudUnavailable ? "重连云端" : "重新检查工作区") : null,
          error ? h("span", { role: "alert", className: "rw-error", title: error.cause?.message ?? error.message }, cloudUnavailable && !error.loginExpired ? "正在自动重连，未发送内容保留在当前浏览器。" : error.message) : null,
          choosing ? h(DirectoryDialog, { title: "工作环境", initial: current, switching: true, canChoose: !!mine,
            onHandoff: !cloudUnavailable && state?.control ? (chosen) => selectWorkspace(chosen, true) : undefined,
            actionLabel: "切换到此工作区", connection: { ...connection, status: availability, ...(error ? { error: error.message, loginExpired: !!error.loginExpired } : {}) }, onProbe: () => probeNow.current(), onCancel: () => setChoosing(false), onChoose: selectWorkspace }) : null);
      }

      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "remote-new-session" }, NewSessionFlow));
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: "remote-workspace", order: -100 }, WorkspaceHeader));
      ctx.slots.inject("conversation.hero.agentPreset", () => ctx.slots.register({ name: "conversation.hero.agentPreset", id: "remote-hero-workspace", priority: -100 }, WorkspaceHeader));
      // The native hero picker describes the history's cloud anchor. Show the
      // actual execution binding through the same environment entry everywhere.
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({ name: "conversation.session.header.actions", id: "agent-preset", priority: -100 }, () => h(React.Fragment)));
      ctx.slots.inject("conversation.input.permission", () => ctx.slots.register({ name: "conversation.input.permission", id: "remote-tool-permissions", priority: -100 }, () => h("span", { className: "rw-meta", title: "工具使用所选机器登录用户的系统权限。工作区决定相对路径；文件侧栏限定在该目录内。" }, "目标用户权限")));
      ctx.slots.inject("tool.call.toolview", () => {
        let installed = false, disposeView;
        const install = () => {
          if (installed) return;
          const native = ctx.slots.entriesOfSlot("tool.call.toolview").find((entry) => entry.options.key === "edit");
          if (!native) return;
          installed = true;
          const NativeEdit = native.component;
          function PiEditView(props) {
            const block = useMemo(() => {
              const diff = props.block.meta?.remotePi?.diff;
              if (props.phase !== "result" || props.block.isError || typeof diff !== "string" || !diff) return props.block;
              // Show the exact applied Pi diff alongside its original output.
              // Argument text cannot establish what a fuzzy edit really changed.
              return { ...props.block, content: [...props.block.content, { type: "text", text: "修改差异：\n" + diff }] };
            }, [props.block, props.phase]);
            return h(NativeEdit, { ...props, block });
          }
          disposeView = ctx.slots.register({ name: "tool.call.toolview", key: "edit", priority: -100, locale: native.locale }, PiEditView);
        };
        install();
        const disposeWatch = ctx.slots.subscribe("tool.call.toolview", install);
        return () => { disposeWatch(); disposeView?.(); };
      });
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

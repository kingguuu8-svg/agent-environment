window.__ModuleLoader__.load({
  id: "remote-dsh-workspaces",
  factory: (require) => {
    const React = require("react");
    const { Modal, MarkdownDelegateProvider, useMarkdownDelegate } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useSyncExternalStore } = React;
    const inject = ["connection", "sessions", "workspaces", "slots", "uiWorkspace", "layout", "sidebarRight", "inputTriggers", "conversation"];

    function createCloudDraftSync({ clientId, getInput, save, select, isCurrent = () => true, notify }) {
      const states = new Map();
      let disposed = false;
      const retainedKey = (id) => `remote-dsh-retained-drafts.${id}`;
      const stateOf = (id) => {
        if (!states.has(id)) {
          let retained = [];
          try { const saved = JSON.parse(sessionStorage.getItem(retainedKey(id))); if (Array.isArray(saved) && saved.every((text) => typeof text === "string" && text)) retained = saved; } catch {}
          states.set(id, { phase: "local", view: null, input: null, touched: false, dirty: false, seq: 0, paused: 0, selecting: false, retained, references: 0, text: "", attachmentCount: 0 });
        }
        return states.get(id);
      };
      const publish = (state, phase) => { state.phase = phase; if (!disposed) notify(); };
      const blockedKey = (id) => `remote-dsh-uncertain-draft.${id}`;
      const rememberBlocked = (id, blocked) => { try { if (!blocked) sessionStorage.removeItem(blockedKey(id)); else sessionStorage.setItem(blockedKey(id), "1"); } catch {} };
      const schedule = (id) => {
        const state = stateOf(id); clearTimeout(state.timer);
        if (!disposed && state.dirty && !state.paused && !state.selecting && !state.blocked && state.view?.control?.mine) state.timer = setTimeout(() => flush(id), 450);
      };
      const changed = (id) => {
        const state = stateOf(id), value = state.input.state.getSnapshot();
        const count = value.attachmentIds.length;
        if (state.text === value.draft && state.attachmentCount === count) return;
        state.text = value.draft; state.attachmentCount = count;
        if (state.seed === value.draft && count === 0) { state.seed = undefined; publish(state, "saved"); return; }
        state.touched = true; state.seq++;
        if (state.blocked) { state.dirty = false; publish(state, "local"); return; }
        state.dirty = !!state.view?.control?.mine;
        publish(state, "local"); schedule(id);
      };
      const receive = (id, view) => {
        const state = stateOf(id);
        if (disposed) return;
        if (state.view?.draft?.revision > view.draft?.revision) view = { ...view, draft: state.view.draft };
        state.view = view;
        if (!view.control?.mine) { state.dirty = false; clearTimeout(state.timer); }
        const draft = view.draft;
        if (view.control?.mine && draft?.revision === 0 && state.input && (state.text || state.attachmentCount) && !state.blocked && !state.dirty) state.dirty = true;
        // Only an untouched editor follows the cloud. Local notes remain local
        // until the user edits them; attachment bytes belong to their window.
        if (draft && state.input && !state.touched && !state.paused && !state.selecting && !state.blocked && draft.attachmentCount === 0 && state.text !== draft.text) {
          state.seed = draft.text;
          state.input.setDraft(draft.text);
        }
        if (!state.dirty && draft && state.text === draft.text && state.attachmentCount === draft.attachmentCount) publish(state, "saved");
        else if (!state.dirty && !state.saving) publish(state, "local");
        else notify();
        schedule(id);
      };
      async function flush(id) {
        const state = stateOf(id); clearTimeout(state.timer);
        if (disposed || state.saving || state.paused || state.selecting || state.blocked || !state.dirty || !state.view?.control?.mine || !state.view.draft) return;
        const seq = state.seq, view = state.view;
        const payload = { sessionId: id, clientId, epoch: view.control.epoch, revision: view.draft.revision, text: state.text, attachmentCount: state.attachmentCount };
        state.saving = true; publish(state, "saving");
        try {
          const result = await save(payload, AbortSignal.timeout(5000));
          if (result.draft.revision >= state.view.draft.revision) state.view = { ...state.view, draft: result.draft };
          if (seq === state.seq) { state.dirty = false; publish(state, result.accepted && state.text === state.view.draft.text && state.attachmentCount === state.view.draft.attachmentCount ? "saved" : "local"); }
        } catch { if (seq === state.seq) publish(state, "local"); }
        finally { state.saving = false; if (seq !== state.seq) schedule(id); }
      }
      return {
        receive, flush,
        attach(id) {
          const state = stateOf(id); state.references++;
          if (!state.input) {
            state.input = getInput(id);
            if (state.input) {
              const value = state.input.state.getSnapshot();
              state.text = value.draft; state.attachmentCount = value.attachmentIds.length;
              state.touched = value.draft !== "" || value.attachmentIds.length > 0;
              try { state.blocked = sessionStorage.getItem(blockedKey(id)) !== null; } catch {}
              state.unsubscribe = state.input.state.subscribe(() => changed(id));
              if (state.view) receive(id, state.view);
            }
          }
          return () => {
            if (--state.references > 0) return;
            void flush(id); state.unsubscribe?.(); state.input = null;
          };
        },
        pause(id) { const state = stateOf(id); clearTimeout(state.timer); state.paused++; state.seq++; state.dirty = false; },
        finish(id, accepted) {
          const state = stateOf(id); state.paused = Math.max(0, state.paused - 1);
          // A failed reply can restore raw references, whitespace or several
          // submissions. Keep all programmatic restoration local until an
          // explicit editor input, including after reload.
          if (!accepted) { state.blocked = true; rememberBlocked(id, true); }
          if (state.text === "" || state.blocked) state.dirty = false;
          schedule(id);
        },
        edited(id) { const state = stateOf(id); if (state.blocked) { state.blocked = false; rememberBlocked(id, false); state.dirty = !!state.view?.control?.mine; schedule(id); } },
        status(id) {
          const state = stateOf(id), draft = state.view?.draft;
          if (state.selecting) return "正在接续草稿";
          if (draft?.attachmentCount && (draft.clientId !== clientId || state.attachmentCount < draft.attachmentCount)) return "草稿含未接续附件";
          if (state.text && draft?.text && state.text !== draft.text && !state.dirty && !state.saving) return "本机原稿 · 云端有另一份";
          if (!state.text && !state.attachmentCount) return "";
          if (state.phase === "saved") return state.attachmentCount ? "文字已同步 · 附件在本机" : "草稿已同步";
          return state.phase === "saving" ? "正在保存草稿" : "草稿暂存本机";
        },
        snapshot(id) { const state = stateOf(id); return [state.phase, state.seq, state.selecting, state.view?.draft?.revision, state.retained.length, state.view?.control?.mine].join("|"); },
        canChoose(id) {
          const state = stateOf(id), draft = state.view?.draft;
          return !!(state.retained.length || (draft?.text && draft.text !== state.text) || (draft?.attachmentCount && draft.clientId !== clientId));
        },
        preview(id) {
          const state = stateOf(id);
          return { sessionId: id, text: state.text, attachmentCount: state.attachmentCount, seq: state.seq, draft: { ...state.view?.draft }, control: { ...state.view?.control }, retained: [...state.retained] };
        },
        async selectText(id, preview, text, signal) {
          const state = stateOf(id);
          if (disposed || !state.input || !isCurrent(id) || state.paused || state.selecting || preview.sessionId !== id
            || preview.seq !== state.seq || preview.text !== state.text || preview.attachmentCount !== state.attachmentCount) throw new Error("输入内容或会话已变化，请重新查看草稿后选择。");
          if (state.attachmentCount) throw new Error("当前输入框含附件，请先发送或移除附件，再接续其他草稿。");
          if (preview.draft.revision !== state.view?.draft?.revision) throw new Error("云端草稿已更新，请重新查看后选择。");
          if (preview.control.mine !== state.view?.control?.mine || preview.control.epoch !== state.view?.control?.epoch) throw new Error("输入权已更新，请重新查看草稿后选择。");
          // Persist before touching either editor or cloud. Keep every displaced
          // text, deduplicated, so repeated choices remain reversible on reload.
          if (state.text && state.text !== text && !state.retained.includes(state.text)) {
            const retained = [...state.retained, state.text];
            try { sessionStorage.setItem(retainedKey(id), JSON.stringify(retained)); }
            catch { throw new Error("无法保存本机原稿，当前内容已保留。请释放浏览器存储空间后重试。"); }
            state.retained = retained;
          }
          clearTimeout(state.timer); state.dirty = false; state.selecting = true;
          const seq = ++state.seq;
          publish(state, "local");
          try {
            const value = await select({ sessionId: id, clientId, epoch: preview.control.epoch, takeover: !preview.control.mine, revision: preview.draft.revision, text }, signal);
            signal?.throwIfAborted();
            if (disposed || !state.input || !isCurrent(id) || seq !== state.seq) throw new Error("会话或输入内容已变化，原稿已保留，请重新查看草稿后选择。");
            if (value.draft.revision < state.view.draft.revision) throw new Error("云端草稿已再次更新，原稿已保留，请重新查看后选择。");
            receive(id, value);
            state.touched = true; state.blocked = false; rememberBlocked(id, false);
            state.seed = text; state.input.setDraft(text); state.dirty = false;
            publish(state, "saved");
            return value;
          } catch (error) {
            // A lost reply can mean selection committed. Do not republish the
            // old local text while reconciling; an explicit edit releases it.
            state.dirty = false; state.blocked = true; rememberBlocked(id, true);
            publish(state, "local"); throw error;
          } finally { state.selecting = false; if (!disposed) notify(); }
        },
        flushAll() { for (const id of states.keys()) void flush(id); },
        dispose() { disposed = true; for (const state of states.values()) { clearTimeout(state.timer); state.unsubscribe?.(); } },
      };
    }

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
      const creationKey = "remote-dsh-pending-creations";
      const pendingCreations = new Map();
      try {
        const saved = JSON.parse(sessionStorage.getItem(creationKey));
        if (Array.isArray(saved) && saved.every((item) => Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && item[0]
          && typeof item[1] === "string" && /^session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item[1]))) for (const [workspaceId, sessionId] of saved) pendingCreations.set(workspaceId, sessionId);
      } catch {}
      const saveCreations = () => {
        if (pendingCreations.size) sessionStorage.setItem(creationKey, JSON.stringify([...pendingCreations]));
        else sessionStorage.removeItem(creationKey);
      };
      const restoredCreation = [...pendingCreations].at(-1);
      let createOpen = false;
      let creation = restoredCreation ? { busy: false, error: "上次新建的结果尚未确认，重试会打开同一会话。", workspaceId: restoredCreation[0], sessionId: restoredCreation[1] } : { busy: false, error: "", workspaceId: null };
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
        drafts.receive(sessionId, value);
        return value;
      };
      const createInWorkspace = (workspaceId) => {
        if (creatingSession) return creatingSession;
        const sessionId = pendingCreations.get(workspaceId) ?? `session-${crypto.randomUUID()}`;
        creation = { busy: true, error: "", workspaceId, sessionId }; notifyCreation();
        creatingSession = (async () => {
          // Persist the identity before sending. Native DSH adopts that identity
          // on retry, even if creation committed but its response was lost.
          pendingCreations.set(workspaceId, sessionId);
          try { saveCreations(); }
          catch { throw new Error("无法保存新建会话的恢复信息，请释放浏览器存储空间后重试。"); }
          await ctx.sessions.create({ workspaceId, sessionId });
          await control(sessionId);
          ctx.uiWorkspace.openSession(sessionId);
          pendingCreations.delete(workspaceId);
          try { saveCreations(); }
          catch {
            pendingCreations.set(workspaceId, sessionId);
            showNotice("会话已打开，浏览器暂时无法清除恢复记录。请释放存储空间后重试。", "error");
          }
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
      const drafts = createCloudDraftSync({ clientId, notify: notifyCreation, save: (request, signal) => api("saveDraft", request, signal),
        select: (request, signal) => api("selectDraft", { ...request, label }, signal), isCurrent: (id) => selection.getSnapshot().sessionId === id, getInput: (id) => {
        const scope = ctx.sessions.scope(id);
        return scope ? ctx.conversation.input.for(scope) : null;
      } });
      ctx.effect(() => {
        const hidden = () => { if (document.visibilityState === "hidden") drafts.flushAll(); };
        const editing = (event) => { const id = selection.getSnapshot().sessionId; if (id && event.target?.closest?.('[role="textbox"][contenteditable="true"]')) drafts.edited(id); };
        document.addEventListener("visibilitychange", hidden);
        document.addEventListener("beforeinput", editing, true);
        document.addEventListener("input", editing, true);
        return () => { document.removeEventListener("visibilitychange", hidden); document.removeEventListener("beforeinput", editing, true); document.removeEventListener("input", editing, true); drafts.dispose(); };
      }, "remote: cloud draft lifetime");
      const wrappedCall = async (channel, endpoint, payload, signal) => {
        if (channel === "/api" && /^session\/(prompt|cancel|updateQueue|selectModel|rename)$/.test(endpoint)) {
          const request = payload.args.request;
          const sending = endpoint === "session/prompt";
          if (sending) drafts.pause(request.sessionId);
          let accepted = false;
          try {
            const value = leases.get(request.sessionId) ?? await control(request.sessionId);
            if (!value.current) return originalCall(channel, endpoint, payload, signal);
            const result = await controlled("input", { sessionId: request.sessionId, method: endpoint.split("/")[1], payload: request, ...(sending ? { draftAck: true } : {}) }, signal);
            accepted = true;
            if (sending) {
              drafts.receive(request.sessionId, { ...leases.get(request.sessionId), draft: result.draft });
            }
            return { ok: true, value: sending ? result.result : result };
          } catch (error) {
            const message = error instanceof CloudConnectionError && endpoint === "session/prompt" ?
              error.message + " 发送结果尚未确认，草稿已保留。恢复后请先检查会话，再决定是否发送。" : error.message;
            return { ok: false, error: { code: "gateway/bad-request", message, details: {} } };
          } finally {
            if (sending) drafts.finish(request.sessionId, accepted);
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
        .rw-host-group+.rw-host-group{margin-top:12px}.rw-host-heading{width:100%;display:flex;align-items:center;gap:8px;padding:8px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#999);font:inherit;font-size:12px;cursor:pointer;text-align:left}.rw-host-heading:hover{background:var(--dsw-alias-interactive-bg-hover,#80808018)}.rw-host-heading:focus-visible{outline:2px solid #729aff;outline-offset:-2px}.rw-host-heading[data-current]{color:var(--dsw-alias-label-primary,inherit)}.rw-host-heading>svg{width:15px;height:15px;flex:none}.rw-host-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-weight:600}.rw-host-count,.rw-host-chevron{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}.rw-host-chevron{font-size:15px;width:10px;text-align:center}
        [class$="_heroWorkspaceRow"]:has(.rw-bar)>button{display:none}
        .rw-button{border:1px solid var(--dsw-alias-border-l4,#80808050);background:transparent;color:inherit;border-radius:8px;padding:7px 11px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px}
        .rw-button:hover,.rw-folder:hover,.rw-machine:hover,.rw-shortcut:hover{background:var(--dsw-alias-interactive-bg-hover,#80808018)}
        .rw-button:disabled,.rw-folder:disabled{opacity:.45;cursor:default}.rw-button:focus-visible,.rw-machine:focus-visible,.rw-folder:focus-visible,.rw-shortcut:focus-visible{outline:2px solid #729aff;outline-offset:2px}
        .rw-primary{background:#356be8;color:white;border-color:transparent}.rw-primary:hover{background:#2d5bcc}
        .rw-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#929699);line-height:1.6}.rw-pending{font-size:12px;color:#c68c21;max-width:350px}
        .rw-tool-origin{font-size:11px;color:var(--dsw-alias-label-tertiary,#929699);padding:0 0 3px 24px;overflow-wrap:anywhere}
        .rw-error{color:var(--dsw-alias-state-danger-primary,#d46161);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
        .rw-status{position:fixed;right:24px;bottom:70px;z-index:1100;background:var(--dsw-alias-bg-layer-2,#202124);color:var(--dsw-alias-label-primary,#eee);border:1px solid #80808050;border-radius:12px;padding:13px 16px;display:flex;align-items:center;gap:10px;max-width:min(480px,calc(100vw - 48px));box-shadow:0 8px 24px #0003;font-size:13px;line-height:1.5}
        .rw-dialog{width:720px!important;max-width:100%;max-height:100%;overflow:hidden!important;display:flex!important;flex-direction:column;gap:0!important;padding:24px!important;font-family:inherit;color:var(--dsw-alias-label-primary,#eee)}
        .rw-dialog-body{overflow:auto;min-height:0;padding-right:2px}.rw-dialog-heading,.rw-description,.rw-selection,.rw-footer{flex-shrink:0}.rw-dialog h2{margin:0;font-size:20px;line-height:1.5;font-weight:550}.rw-dialog-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px}.rw-description{font-size:13px;color:var(--dsw-alias-label-secondary,#999);margin:0 0 20px;line-height:1.6}
        .rw-draft-choices{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.rw-draft-choices [aria-checked="true"]{border-color:#729aff;background:#729aff18}.rw-draft-preview{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px;line-height:1.6;padding:14px;border:1px solid var(--dsw-alias-border-l4,#80808040);border-radius:10px;margin:0;max-height:35vh;overflow:auto}
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
      ctx.slots.inject("sidebar.workspaces", () => {
        let catalog = null, loading = null, reload = false, disposed = false, preparing = false;
        const subscribers = new Set(), controller = new AbortController();
        const refresh = () => {
          if (disposed) return;
          if (loading) { reload = true; return; }
          loading = api("catalog", {}, controller.signal).then((value) => {
            if (!disposed) { catalog = value; for (const listener of subscribers) listener(); }
          }).catch(() => {}).finally(() => {
            loading = null;
            if (reload) { reload = false; refresh(); }
          });
        };
        const disposeRoot = ctx.slots.provideRoot({ props: {
          remoteSidebarCatalog: { getSnapshot: () => catalog, subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); } },
          remoteSidebarActions: { async createWorkspace(target) {
            if (preparing || creatingSession) return;
            preparing = true; showNotice("正在准备工作区…");
            try {
              const picked = await api("pick", { machine: target.machine, workspace: target.workspace });
              await createInWorkspace(picked.workspaceId); refresh();
            } catch (error) { showNotice(error.message, "error"); }
            finally { preparing = false; }
          } },
        } });
        const unsubscribe = ctx.workspaces.list.subscribe(refresh);
        const visible = () => { if (document.visibilityState === "visible") refresh(); };
        document.addEventListener("visibilitychange", visible);
        const timer = setInterval(visible, 30000);
        refresh();
        return () => { disposed = true; controller.abort(); clearInterval(timer); unsubscribe(); disposeRoot(); subscribers.clear(); document.removeEventListener("visibilitychange", visible); };
      });
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
        const choiceRequest = useRef();
        const generation = useRef(0);
        const committing = useRef(false);
        const lastPaths = useRef(new Map());
        const busy = saving || ownerBusy;
        const cancelDisabled = ownerBusy || (saving && !switching);
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
          return () => { catalogRequest.current?.abort(); lifetime.current?.abort(); choiceRequest.current?.abort(); generation.current++; };
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
          const abort = switching ? new AbortController() : undefined;
          choiceRequest.current = abort;
          try { await (takingOver ? onHandoff : onChoose)({ machine, workspace: listing.absolutePath }, abort?.signal); }
          catch (failure) { if (!abort?.signal.aborted) { committing.current = false; setError(failure.message); setSaving(false); } }
        };
        const cancel = () => {
          if (cancelDisabled) return;
          choiceRequest.current?.abort();
          onCancel();
        };
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
          h("div", { className: "rw-dialog-heading" }, h("h2", null, title), h("button", { type: "button", className: "rw-button", disabled: cancelDisabled, "aria-label": "关闭", "data-modal-autofocus": true, onClick: cancel }, "×")),
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
          saving && switching ? h("p", { className: "rw-meta", role: "status" }, "正在连接并检查目标工作区，可随时取消等待。") : null,
          h("div", { className: "rw-footer" },
            h("div", null, h("span", { className: "rw-meta" }, takingOver ? "确认后，此窗口接管输入；原窗口继续查看。执行中的任务保留原工作区。" : !canChoose ? "查看模式：接管输入后可切换工作区。" : switching ? "模型提示词和文件侧栏随工作区更新。" : listing?.truncated ? "目录较多，可输入完整路径前往。" : "记录在云端，文件留在所选机器。"),
              h("button", { type: "button", className: "rw-button", style: { marginTop: "8px", display: "flex" }, disabled: busy, onClick: () => setSetupOpen(true) }, "接入新设备")),
            h("div", { className: "rw-footer-actions" },
              h("button", { type: "button", className: "rw-button", disabled: cancelDisabled, onClick: cancel }, saving && switching ? "取消准备" : "取消"),
              h("button", { type: "button", className: "rw-button rw-primary", disabled: busy || loading || !listing || changedPath || !canCommit || sameWorkspace, onClick: commit }, busy ? takingOver ? "正在接管并准备工作区…" : "正在准备工作区…" : sameWorkspace ? "当前工作区" : takingOver ? "接管并切换" : actionLabel)))
        );
      }

      function NewSessionFlow() {
        const open = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => createOpen);
        const status = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => creation);
        const message = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => notice);
        const toast = message ? h("div", { className: "rw-status", role: message.kind === "error" ? "alert" : "status" }, message.message) : null;
        const progress = status.busy || status.error ? h("div", { className: "rw-status", role: status.error ? "alert" : "status" },
          h("span", { className: status.error ? "rw-error" : "rw-meta" }, status.error ? `新建会话暂未完成：${status.error}` : "正在新建会话…"),
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
      function DraftChoiceDialog({ preview, onCancel, onSelect, onRefresh }) {
        const candidates = [{ key: "cloud", label: "云端草稿", text: preview.draft.text ?? "", attachmentCount: preview.draft.attachmentCount ?? 0 },
          ...preview.retained.slice().reverse().map((text, index) => ({ key: `local-${index}`, label: "本机原稿" + (preview.retained.length > 1 ? ` ${preview.retained.length - index}` : ""), text }))];
        const initial = candidates[0].text && (candidates[0].text !== preview.text || candidates[0].attachmentCount) ? "cloud" : candidates[1]?.key ?? "cloud";
        const [choice, setChoice] = useState(initial);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const request = useRef();
        const mounted = useRef(true);
        useEffect(() => () => { mounted.current = false; request.current?.abort(); }, []);
        useEffect(() => { setChoice(initial); }, [preview]);
        const selected = candidates.find((item) => item.key === choice) ?? candidates[0];
        const cancel = () => { request.current?.abort(); onCancel(); };
        const run = async (refresh = false) => {
          if (busy) return;
          const abort = new AbortController(); request.current = abort;
          setBusy(true); setError("");
          try {
            const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]);
            await (refresh ? onRefresh(signal) : onSelect(preview, selected, signal));
          } catch (failure) {
            if (mounted.current && !abort.signal.aborted) setError(failure.name === "TimeoutError" ? "云端结果暂未确认，原稿已保留。重新查看草稿后再选择。" : failure.message);
          } finally { if (mounted.current) setBusy(false); }
        };
        const blocked = preview.attachmentCount > 0;
        const same = selected.text === preview.text && !selected.attachmentCount;
        const action = selected.key === "cloud" ? selected.attachmentCount ? "仅接续文字" : "接续云端草稿" : "恢复本机原稿";
        return h(Modal, { open: true, headless: true, title: "接续草稿", onClose: cancel, className: "rw-dialog" },
          h("div", { className: "rw-dialog-heading" }, h("h2", null, "接续草稿"), h("button", { type: "button", className: "rw-button", "aria-label": "关闭草稿预览", onClick: cancel }, "×")),
          h("p", { className: "rw-description" }, "选择要继续编辑的文字。替换前会在当前窗口保留原稿，刷新后仍可恢复。"),
          h("div", { className: "rw-dialog-body" },
            h("div", { className: "rw-draft-choices", role: "radiogroup", "aria-label": "草稿来源" }, candidates.map((item) => h("button", { type: "button", className: "rw-button", key: item.key, role: "radio", "aria-checked": selected.key === item.key, disabled: busy, onClick: () => { setChoice(item.key); setError(""); } }, item.label))),
            h("pre", { className: "rw-draft-preview", "aria-label": selected.label + "内容" }, selected.text || "暂无文字草稿"),
            selected.attachmentCount ? h("p", { className: "rw-meta" }, `此草稿有 ${selected.attachmentCount} 个附件，保留在原窗口。接续后请重新选择附件，或回原窗口发送。`) : null,
            blocked ? h("p", { className: "rw-error", role: "alert" }, "当前输入框含附件，请先发送或移除附件，再接续其他草稿。") : null,
            !preview.control.mine ? h("p", { className: "rw-meta" }, "确认后，此窗口接管输入。会话历史和工作区保持。") : null,
            error ? h("p", { className: "rw-error", role: "alert" }, error) : null),
          h("div", { className: "rw-footer" }, h("div", { className: "rw-footer-actions" },
            h("button", { type: "button", className: "rw-button", disabled: busy, onClick: () => run(true) }, "重新查看"),
            h("button", { type: "button", className: "rw-button", onClick: cancel }, "保留当前输入"),
            h("button", { type: "button", className: "rw-button rw-primary", disabled: busy || blocked || !selected.text || same, onClick: () => run() }, busy ? "正在连接…" : (preview.control.mine ? "" : "接管并") + action))));
      }
      function WorkspaceHeader({ sessionId, useProjection }) {
        const binding = useProjection("remoteBinding");
        const [snapshot, setSnapshot] = useState(null);
        const [choosing, setChoosing] = useState(false);
        const [draftPreview, setDraftPreview] = useState(null);
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
          drafts.receive(sessionId, value);
          if (activeSession.current !== sessionId) return;
          setSnapshot((previous) => {
            if (previous && previous.sessionId === sessionId && (previous.value.revision > value.revision || JSON.stringify(previous.value) === JSON.stringify(value))) return previous;
            return { sessionId, value };
          });
        };
        useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => drafts.snapshot(sessionId));
        useEffect(() => sessionId ? drafts.attach(sessionId) : undefined, [sessionId]);
        useEffect(() => {
          setChoosing(false); setDraftPreview(null); setError(null);
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
        const selectWorkspace = async (chosen, takeover = false, signal) => {
          const request = { sessionId, revision: effective.revision, ...chosen };
          try {
            const value = takeover ? await api("switch", { ...request, takeover: true, clientId, label }, signal) : await controlled("switch", request, signal);
            signal?.throwIfAborted();
            setView(value);
            if (activeSession.current !== sessionId) return;
            setChoosing(false);
            if (value.pending) showNotice((takeover ? "已接管输入。" : "") + "已安排切换。当前任务继续在原工作区执行，结束后切换至 " + shortTarget(value.pending) + "。");
            else if (takeover) showNotice("已接管输入并切换至 " + shortTarget(value.current) + "，可以继续同一条会话。");
          } catch (failure) {
            if (!signal?.aborted) throw failure;
            // The carrier cancels preparation on HTTP close. A completed commit
            // can still lose its reply, so reconcile rather than roll it back.
            try {
              const value = await api("get", { sessionId, clientId }, AbortSignal.timeout(5000));
              setView(value);
              if (activeSession.current !== sessionId) return;
              setError(null);
              showNotice(value.revision === request.revision ? "已取消工作区准备，继续使用 " + shortTarget(value.current) + "。" :
                "已停止等待。云端当前工作区：" + shortTarget(value.current) + (value.pending ? "；任务结束后切换至 " + shortTarget(value.pending) : "") + "。");
            } catch (confirmationError) {
              if (activeSession.current !== sessionId) return;
              setError(confirmationError.name === "TimeoutError" ? new CloudConnectionError(confirmationError) : confirmationError);
              showNotice("已停止等待，云端结果暂未确认。恢复连接后请检查工作环境。", "error");
            }
          }
        };
        return h("div", { className: "rw-bar", "data-remote-machine": current.machine, "data-remote-workspace": current.workspace },
          h("button", { type: "button", className: "rw-button rw-target", "aria-label": "工作环境：" + shortTarget(current), title: current.workspace + "\n点击查看机器、目录和连接，或切换工作区。", onClick: () => setChoosing(true) },
            h("span", { className: "rw-dot", "data-status": availability }), h("span", { className: "rw-target-label" }, shortTarget(current)), h("span", { className: "rw-target-status" }, statusLabel), h("span", { "aria-hidden": true }, "⌄")),
          mine ? h("span", { className: "rw-control", title: cloudUnavailable ? "未发送内容保留在当前浏览器。连接恢复后先检查会话，再决定是否发送。" : "会话记录保存在 VPS4，此窗口可以提交输入。" }, cloudUnavailable ? "草稿保留 · 等待重连" : "云端记录 · 可输入") :
            h("button", { type: "button", className: "rw-button", disabled: cloudUnavailable, onClick: async () => {
              try { setView(await control(sessionId, true)); setError(null); showNotice("已接管输入，可以继续这条会话。"); } catch (failure) { setError(failure); }
            } }, "接管输入"),
          !mine && state?.control ? h("span", { className: "rw-meta", style: { maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: state.control.label }, "查看模式 · " + state.control.label) : null,
          drafts.status(sessionId) ? h("span", { className: "rw-meta" }, drafts.status(sessionId)) : null,
          drafts.canChoose(sessionId) ? h("button", { className: "rw-button", type: "button", disabled: cloudUnavailable, onClick: () => setDraftPreview(drafts.preview(sessionId)) }, "查看草稿") : null,
          pending ? h("span", { className: "rw-pending", title: pending.workspace }, "当前任务结束后切换至 " + shortTarget(pending), mine ? h("button", { type: "button", className: "rw-button", onClick: async () => {
            try { setView(await controlled("discardSwitch", { sessionId })); showNotice("已撤回待切换工作区。"); } catch (failure) { setError(failure); }
          } }, "撤回") : null) : null,
          ["unavailable", "cloud-offline"].includes(availability) && !error?.loginExpired ? h("button", { className: "rw-button", type: "button", onClick: () => { refreshNow.current(); probeNow.current(); } }, cloudUnavailable ? "重连云端" : "重新检查工作区") : null,
          error ? h("span", { role: "alert", className: "rw-error", title: error.cause?.message ?? error.message }, cloudUnavailable && !error.loginExpired ? "正在自动重连，未发送内容保留在当前浏览器。" : error.message) : null,
          draftPreview ? h(DraftChoiceDialog, { preview: draftPreview, onCancel: () => setDraftPreview(null),
            onRefresh: async (signal) => {
              const value = await api("get", { sessionId, clientId }, signal);
              signal.throwIfAborted(); setView(value);
              if (activeSession.current === sessionId) setDraftPreview(drafts.preview(sessionId));
            },
            onSelect: async (preview, selected, signal) => {
              const value = await drafts.selectText(sessionId, preview, selected.text, signal);
              setView(value);
              if (activeSession.current !== sessionId) return;
              setDraftPreview(null); setError(null);
              showNotice((selected.key === "cloud" ? "已接续云端文字。" : "已恢复本机原稿。") + (preview.text && preview.text !== selected.text ? "原输入已保留，可从“查看草稿”恢复。" : ""));
            } }) : null,
          choosing ? h(DirectoryDialog, { title: "工作环境", initial: current, switching: true, canChoose: !!mine,
            onHandoff: !cloudUnavailable && state?.control ? (chosen, signal) => selectWorkspace(chosen, true, signal) : undefined,
            actionLabel: "切换到此工作区", connection: { ...connection, status: availability, ...(error ? { error: error.message, loginExpired: !!error.loginExpired } : {}) }, onProbe: () => probeNow.current(), onCancel: () => setChoosing(false), onChoose: (chosen, signal) => selectWorkspace(chosen, false, signal) }) : null);
      }

      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "remote-new-session" }, NewSessionFlow));
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: "remote-workspace", order: -100 }, WorkspaceHeader));
      ctx.slots.inject("conversation.hero.agentPreset", () => ctx.slots.register({ name: "conversation.hero.agentPreset", id: "remote-hero-workspace", priority: -100 }, WorkspaceHeader));
      // The native hero picker describes the history's cloud anchor. Show the
      // actual execution binding through the same environment entry everywhere.
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({ name: "conversation.session.header.actions", id: "agent-preset", priority: -100 }, () => h(React.Fragment)));
      ctx.slots.inject("conversation.input.permission", () => ctx.slots.register({ name: "conversation.input.permission", id: "remote-tool-permissions", priority: -100 }, () => h("span", { className: "rw-meta", title: "工具使用所选机器登录用户的系统权限。工作区决定相对路径；文件侧栏限定在该目录内。" }, "目标用户权限")));
      const openHistoricalFile = async (method, identity, path, options) => {
        try {
          const value = await api(method, identity);
          if (selection.getSnapshot().sessionId !== identity.sessionId) return;
          const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
          const address = `dsh-resource://file/session/${encodeURIComponent(value.scopeId)}/${normalized.split("/").map((part) => encodeURIComponent(part).replace(/%3A/gi, ":")).join("/")}`;
          ctx.sidebarRight.openResource(address, options?.line === undefined ? {} : { params: { line: options.line } });
          showNotice(`正在查看 ${shortTarget(value.binding)} 的当前文件。`);
        } catch (error) { showNotice(error.message, "error"); }
      };
      ctx.slots.inject("conversation.chat.node", () => {
        let disposeView;
        const install = () => {
          if (disposeView) return;
          const native = ctx.slots.entriesOfSlot("conversation.chat.node").find((entry) => entry.options.key === "assistant-step");
          if (!native) return;
          const NativeAssistant = native.component;
          function HistoricalAssistant(props) {
            const parent = useMarkdownDelegate();
            const { turn, step } = props.node.data;
            const openFile = useMemo(() => props.historySessionId ? (path, options) =>
              openHistoricalFile("replyOrigin", { sessionId: props.historySessionId, turn, step }, path, options) : props.openFile,
            [props.historySessionId, turn, step, props.openFile]);
            const fileImages = useMemo(() => !props.historySessionId || !parent?.fileImages ? parent?.fileImages : {
              ...parent.fileImages,
              resolve: (path) => {
                const url = new URL("api/remote-reply-image", document.baseURI);
                url.search = new URLSearchParams({ reply: JSON.stringify([props.historySessionId, turn, step]), path }).toString();
                return url.href;
              },
            }, [props.historySessionId, turn, step, parent?.fileImages]);
            // Native Markdown links read context; prose file mentions use the
            // prop. Keep native images and their UI, with the same reply origin.
            return h(MarkdownDelegateProvider, { ...parent, openFile, fileImages }, h(NativeAssistant, { ...props, openFile }));
          }
          disposeView = ctx.slots.register({ name: "conversation.chat.node", key: "assistant-step", priority: -100, locale: native.locale,
            inject: (sessionId) => ({ ...native.inject?.(sessionId), historySessionId: sessionId }),
          }, HistoricalAssistant);
        };
        install();
        const disposeWatch = ctx.slots.subscribe("conversation.chat.node", install);
        return () => { disposeWatch(); disposeView?.(); };
      });
      ctx.slots.inject("tool.call.toolview", () => {
        const views = new Map();
        const install = () => {
          for (const key of ["read", "write", "edit"]) {
            if (views.has(key)) continue;
            const native = ctx.slots.entriesOfSlot("tool.call.toolview").find((entry) => entry.options.key === key);
            if (!native) continue;
            const NativeFileView = native.component;
            function PiFileView(props) {
              const current = props.useToolBinding?.((snapshot) => snapshot?.current);
              const details = props.block.meta?.remotePi;
              const origin = details?.origin ?? (details?.remote ? { id: details.workspace, ...details.remote } : null);
              const block = useMemo(() => {
                const diff = details?.diff;
                if (key !== "edit" || props.phase !== "result" || props.block.isError || typeof diff !== "string" || !diff) return props.block;
                return { ...props.block, content: [...props.block.content, { type: "text", text: "修改差异：\n" + diff }] };
              }, [props.block, props.phase]);
              const openFile = props.historySessionId ? (path, options) =>
                openHistoricalFile("toolOrigin", { sessionId: props.historySessionId, callId: props.callId }, path, options) : props.openFile;
              return h(React.Fragment, null,
                h(NativeFileView, { ...props, block, openFile, cwd: origin?.workspace ?? props.cwd }),
                props.phase === "result" && !props.block.isError && origin && typeof origin.machine === "string" && typeof origin.workspace === "string" && origin.id !== current?.id ?
                  h("div", { className: "rw-tool-origin", title: `${origin.machine} · ${origin.workspace}` }, `执行于 ${shortTarget(origin)}`) : null);
            }
            // Slot inject binds the actual owning session, including forked and
            // restored history. A currently selected window is not its identity.
            views.set(key, ctx.slots.register({ name: "tool.call.toolview", key, priority: -100, locale: native.locale,
              inject: (sessionId) => ({ historySessionId: sessionId, hooks: { toolBinding: ctx.sessions.binding(sessionId).session.projections.faceOf("remoteBinding") } }),
            }, PiFileView));
          }
        };
        install();
        const disposeWatch = ctx.slots.subscribe("tool.call.toolview", install);
        return () => { disposeWatch(); for (const dispose of views.values()) dispose(); };
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
    return { inject, apply, createCloudDraftSync };
  },
});

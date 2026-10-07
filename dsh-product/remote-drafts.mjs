/** Keep a tab's unsent text when another controller edits the same conversation. */
export function remoteConversationStore(defineStore, declaration, sessions) {
  const handle = defineStore(declaration);
  const create = handle.create;
  handle.create = (sessionId) => {
    const clientId = typeof document === "undefined" ? null : document.documentElement.dataset.remoteDshClient;
    if (!clientId || sessionId === undefined) return create(sessionId);
    const name = `${declaration.persist}.${sessionId}`;
    const ownName = `remote-dsh-window.${name}`;
    const read = (storage, key) => {
      try {
        const value = JSON.parse(storage.getItem(key));
        return value && typeof value.draft === "string" && (value.view === null || typeof value.view === "string") ? value : null;
      } catch { return null; }
    };
    const shared = () => typeof localStorage === "undefined" ? null : read(localStorage, name);
    const own = () => typeof sessionStorage === "undefined" ? null : read(sessionStorage, ownName);
    const saveOwn = (value) => {
      try { sessionStorage.setItem(ownName, JSON.stringify(value)); } catch {}
    };
    // The shared record continues to recover the latest draft in a fresh tab.
    // Existing tabs recover their own snapshot, including an explicitly empty draft.
    const initial = own() ?? shared() ?? declaration.init();
    const instance = defineStore({ ...declaration, persist: undefined, init: () => initial }).create(sessionId);
    let previous = instance.getSnapshot();
    saveOwn(previous);
    instance.subscribe(() => {
      const value = instance.getSnapshot();
      saveOwn(value);
      try {
        const controller = sessions.binding(sessionId)?.session.projections.faceOf("remoteController").getSnapshot();
        const latest = shared() ?? declaration.init();
        // View changes and read-only windows must not replace another tab's draft.
        const draft = controller?.clientId === clientId && value.draft !== previous.draft ? value.draft : latest.draft;
        localStorage.setItem(name, JSON.stringify({ ...value, draft }));
      } catch {}
      previous = value;
    });
    instance.clearPersisted = () => {
      try { sessionStorage.removeItem(ownName); } catch {}
      try { localStorage.removeItem(name); } catch {}
    };
    return instance;
  };
  return handle;
}

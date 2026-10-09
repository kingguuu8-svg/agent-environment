/** Directory selection has private, disposable connections; session tools keep theirs. */
import { openWorkspace } from "./remote-agent.mjs";

async function waitFor(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

export class DirectoryBrowser {
  constructor(environment, { connectTimeout = 300000, readTimeout = 6000 } = {}) {
    this.environment = environment;
    this.connectTimeout = connectTimeout;
    this.readTimeout = readTimeout;
    this.connections = new Map();
  }

  async connect(machine, root, signal) {
    const environment = this.environment;
    if (machine !== "cloud" && !environment.configuration.targets?.[machine]) throw new Error(`Unknown SSH machine: ${machine}`);
    const key = `${machine}\0${root}`;
    let entry = this.connections.get(key);
    if (!entry) {
      entry = {};
      this.connections.set(key, entry);
      entry.opening = openWorkspace({
        ...(machine === "cloud" ? { localWorkspace: root } : { config: environment.config, machine, workspace: root, python: environment.python }),
        readContext: false, connectTimeout: this.connectTimeout,
      }).then(async (connection) => {
        if (this.connections.get(key) !== entry) {
          await connection.close();
          throw new Error("Directory browser closed during connection setup");
        }
        entry.connection = connection;
        const onClose = connection.client.onclose;
        connection.client.onclose = () => {
          if (this.connections.get(key) === entry) this.connections.delete(key);
          onClose?.();
        };
        return connection;
      }).catch((error) => {
        if (this.connections.get(key) === entry) this.connections.delete(key);
        throw error;
      });
    }
    return { key, entry, connection: await waitFor(entry.opening, signal) };
  }

  async list(machine, root, path, signal) {
    // Lists are read-only. A lost reply can be retried on a new browser
    // transport; model tools never enter this recovery path.
    for (let attempt = 0; attempt < 2; attempt++) {
      let active;
      try {
        active = await this.connect(machine, root, signal);
        signal?.throwIfAborted();
        const uri = `workspace://files?request=${encodeURIComponent(JSON.stringify({ op: "list", ...(path ? { path } : {}) }))}`;
        const result = await active.connection.client.readResource({ uri }, { signal, timeout: this.readTimeout });
        signal?.throwIfAborted();
        return JSON.parse(result.contents[0].text);
      } catch (error) {
        if (signal?.aborted || !active) throw error;
        const transportFailure = error.code === -32000 || error.code === -32001 || !active.connection.client.transport;
        if (!transportFailure) throw error;
        if (this.connections.get(active.key) === active.entry) this.connections.delete(active.key);
        await active.connection.close().catch(() => {});
        if (attempt) throw error;
      }
    }
  }

  async close() {
    const entries = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(entries.map(async (entry) => (await entry.opening).close()));
  }
}

/** Machine/workspace identities are stable; connections and availability are transient. */
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { openWorkspace, toolNames } from "./remote-agent.mjs";
import { readJson, writeJson } from "./state-json.mjs";
export { readJson, writeJson } from "./state-json.mjs";

export class Environment {
  constructor({ stateDir, config, python, cloudWorkspace }) {
    this.file = join(stateDir, "environment.json");
    this.config = config ? resolve(config) : undefined;
    this.python = python;
    this.configuration = this.config ? readJson(this.config, {}) : {};
    this.entries = new Map(Object.entries(readJson(this.file, {})));
    this.connections = new Map();
    this.connecting = new Map();
    this.version = 0;
    this.manifest = readJson(new URL("./pi-tools.json", import.meta.url)).tools.filter((tool) => toolNames.includes(tool.name));
    const workspace = realpathSync(cloudWorkspace);
    if (!statSync(workspace).isDirectory()) throw new Error("Cloud workspace must be a directory");
    if (this.entries.has("cloud") && this.entries.get("cloud").workspace !== workspace) {
      throw new Error("Cloud workspace changed; use a separate state directory");
    }
    this.entries.set("cloud", { ...this.entries.get("cloud"), kind: "local", machine: "cloud", workspace });
    for (const [id, endpoint] of Object.entries(this.configuration.mcp ?? {})) {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(id) || this.entries.has(id) && this.entries.get(id).kind !== "mcp") {
        throw new Error(`Invalid or conflicting MCP environment name: ${id}`);
      }
      this.entries.set(id, { ...this.entries.get(id), kind: "mcp", url: endpoint.url });
    }
    this.save();
  }

  save() { writeJson(this.file, Object.fromEntries(this.entries)); }
  get(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown workspace or service: ${id}`);
    return entry;
  }
  list() {
    return [...this.entries].map(([id, entry]) => ({
      id, kind: entry.kind, machine: entry.machine, workspace: entry.workspace,
      uri: entry.context?.binding?.uri ?? entry.url,
      availability: this.connections.has(id) ? "connected" : entry.lastError ? "unavailable" : "disconnected",
      ...(entry.lastError ? { error: entry.lastError } : {}),
    }));
  }

  async discover(signal) {
    signal?.throwIfAborted();
    const discovery = Promise.allSettled(this.list().filter((target) => target.kind === "mcp").map((target) => this.connect(target.id)));
    let onAbort;
    try {
      // Only the caller stops waiting. Other sessions share these connections.
      await (signal ? Promise.race([discovery, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]) : discovery);
      signal?.throwIfAborted();
      return this.list().map((target) => ({ ...target, tools: this.descriptors(target.id) }));
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async register(machine, workspace) {
    if (machine === "cloud") {
      const canonical = realpathSync(workspace);
      if (!statSync(canonical).isDirectory()) throw new Error("Workspace must be a directory");
      if (canonical === this.get("cloud").workspace) return "cloud";
      const id = "w_" + createHash("sha256").update(`cloud\0${canonical}`).digest("hex").slice(0, 16);
      if (!this.entries.has(id)) {
        this.entries.set(id, { kind: "local", machine: "cloud", workspace: canonical });
        await this.connect(id);
        this.version++;
        this.save();
      }
      return id;
    }
    if (!this.configuration.targets?.[machine]) throw new Error(`Unknown SSH machine: ${machine}`);
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("Provide an existing workspace directory");
    const existing = [...this.entries].find(([, entry]) => entry.machine === machine && entry.workspace === workspace);
    if (existing) return existing[0]; // Saved sessions remain accessible while the machine is offline.
    const connection = await openWorkspace({ config: this.config, machine, workspace, python: this.python });
    const canonical = connection.context.binding.workspace;
    const id = "w_" + createHash("sha256").update(`${machine}\0${connection.context.binding.uri}`).digest("hex").slice(0, 16);
    if (this.entries.has(id)) { await connection.close(); return id; }
    this.entries.set(id, { kind: "ssh", machine, workspace: canonical, context: connection.context });
    this.connections.set(id, connection);
    this.version++;
    this.save();
    return id;
  }

  async connect(id) {
    if (this.connections.has(id)) return this.connections.get(id);
    if (this.connecting.has(id)) return this.connecting.get(id);
    const promise = this.open(id);
    this.connecting.set(id, promise);
    try { return await promise; }
    finally { this.connecting.delete(id); }
  }

  async open(id) {
    const entry = this.get(id);
    let connection;
    try {
      if (entry.kind === "mcp") {
        const client = new Client({ name: "cloud-pi-environment", version: "0.1.0" });
        connection = { client, close: () => client.close() };
        const endpoint = this.configuration.mcp[id];
        const deadline = new AbortController();
        const timer = setTimeout(() => {
          deadline.abort(new Error(`MCP service ${id}: initialization and tool discovery timed out after 12 seconds. Retry discovery when the service is available.`));
          // The SDK's initialized notification has no request AbortSignal.
          // Close only this initializing client to also interrupt that HTTP send.
          void client.close().catch(() => {});
        }, 12000);
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), {
            requestInit: endpoint.headers ? { headers: endpoint.headers } : undefined,
          }), { signal: deadline.signal });
          connection.descriptors = [];
          let cursor;
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, { signal: deadline.signal });
            connection.descriptors.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor);
          deadline.signal.throwIfAborted();
        } catch (error) {
          throw deadline.signal.aborted ? deadline.signal.reason : error;
        } finally { clearTimeout(timer); }
        if (JSON.stringify(entry.descriptors) !== JSON.stringify(connection.descriptors)) this.version++;
        entry.descriptors = connection.descriptors;
      } else {
        connection = await openWorkspace(entry.kind === "local"
          ? { localWorkspace: entry.workspace }
          : { config: this.config, machine: entry.machine, workspace: entry.workspace, python: this.python });
        if (entry.context && entry.context.binding.uri !== connection.context.binding.uri) {
          throw new Error(`Workspace identity changed: ${id}`);
        }
        entry.context = connection.context;
      }
      delete entry.lastError;
      this.connections.set(id, connection);
      this.save();
      return connection;
    } catch (error) {
      await connection?.close().catch(() => {});
      entry.lastError = error.message;
      this.save();
      throw error;
    }
  }

  async refresh(id, signal, onConnection) {
    const entry = this.get(id);
    let connection;
    try {
      connection = await this.connect(id);
      signal?.throwIfAborted();
      // A caller's own deadline must be fenced against this exact read.
      onConnection?.(connection);
      if (connection.fetchContext) {
        const context = await connection.fetchContext(signal);
        signal?.throwIfAborted();
        if (this.connections.get(id) !== connection) return entry.context;
        if (context.binding.uri !== entry.context.binding.uri) throw new Error(`Workspace identity changed: ${id}`);
        entry.context = context;
      }
      if (this.connections.get(id) !== connection) return entry.context;
      delete entry.lastError;
      this.save();
    } catch (error) {
      // Preparing one turn also uses this shared connection. Cancellation or
      // a request timeout must leave unrelated sessions' tools running.
      if (signal?.aborted) throw error;
      // Opening already records its own failure. An old read cannot overwrite
      // facts or availability from a connection another session has restored.
      if (connection && this.connections.get(id) === connection) {
        entry.lastError = error.message;
        this.save();
        if (error.code !== -32001) await this.disconnect(id, connection);
      }
    }
    return entry.context;
  }

  descriptors(id) { return this.get(id).kind === "mcp" ? this.get(id).descriptors ?? [] : this.manifest; }

  definition(id, descriptor, exposedName = `${id}__${descriptor.name}`) {
    const entry = this.get(id);
    const uri = entry.context?.binding?.uri ?? entry.url ?? `${entry.machine}:${entry.workspace}`;
    return {
      name: exposedName, label: `${id} / ${descriptor.name}`,
      description: `${descriptor.description}\nExecution target: ${id} (${uri}).`,
      parameters: descriptor.inputSchema,
      promptSnippet: descriptor._meta?.["pi/promptSnippet"],
      ...(entry.kind !== "mcp" && descriptor.name === "edit" ? {
        prepareArguments: createEditToolDefinition(entry.workspace).prepareArguments,
      } : {}),
      execute: async (callId, args, signal, onUpdate) => {
        const connection = await this.connect(id);
        signal?.throwIfAborted();
        let result;
        try {
          result = await connection.client.callTool({ name: descriptor.name, arguments: args }, undefined, {
            signal, timeout: 150000,
            ...(onUpdate ? { onprogress: (progress) => onUpdate({
              content: [{ type: "text", text: progress.message ?? "" }], details: { workspace: id },
            }) } : {}),
          });
        } catch (error) {
          // Cancellation is per request. Closing a shared workspace connection
          // here would also abort tools belonging to other cloud sessions.
          if (signal?.aborted || error.code === -32001) throw new Error(`${uri}: ${error.message}`);
          // A lost response may follow a successful mutation. Never replay it.
          if (this.connections.get(id) === connection) {
            // Record failure before awaiting close: recovery may complete
            // during teardown, and its successful state must remain current.
            entry.lastError = error.message;
            this.save();
            await this.disconnect(id, connection);
          }
          throw new Error(`${uri}: ${error.message}`);
        }
        if (result.isError) throw new Error(`${uri}: ${result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")}`);
        return { content: result.content, details: {
          ...result._meta?.["pi/details"], workspace: id,
          ...(entry.context?.binding ? { remote: entry.context.binding } : {}),
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        } };
      },
    };
  }

  async disconnect(id, expected) {
    const connection = this.connections.get(id);
    if (expected && connection !== expected) return false;
    this.connections.delete(id);
    await connection?.close().catch(() => {});
    return !!connection;
  }
  async close() {
    await Promise.allSettled([...this.connecting.values()]);
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}

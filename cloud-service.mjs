/** Single-user cloud session owner. Terminals attach over a private Unix socket/SSH. */
import { getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import lockfile from "proper-lockfile";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createCloudAgent } from "./cloud-agent.mjs";
import { Environment, readJson, writeJson } from "./environment.mjs";

export const defaultCloudState = join(homedir(), ".local/share/remote-mcp-demo/cloud");

function serviceLock(stateDir) {
  try { return lockfile.lockSync(stateDir, { stale: 10000, update: 2000 }); }
  catch (error) { if (error.code === "ELOCKED") throw new Error("A cloud service already owns this state directory"); throw error; }
}

function persistInitial(manager) {
  if (!existsSync(manager.getSessionFile())) {
    writeFileSync(manager.getSessionFile(), [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  }
  return SessionManager.open(manager.getSessionFile(), manager.getSessionDir());
}

export class CloudService {
  constructor(options = {}) {
    this.options = options;
    this.stateDir = resolve(options.stateDir ?? defaultCloudState);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.releaseLock = serviceLock(this.stateDir);
    try {
    this.sessionsDir = join(this.stateDir, "sessions");
    this.recordsDir = join(this.stateDir, "records");
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.recordsDir, { recursive: true, mode: 0o700 });
    this.records = new Map();
    this.clients = new Set();
    this.socketPath = join(this.stateDir, "service.sock");
    this.environment = new Environment({
      ...options, stateDir: this.stateDir, cloudWorkspace: resolve(options.cloudWorkspace ?? this.stateDir),
    });
    for (const name of readdirSync(this.recordsDir).filter((name) => name.endsWith(".json"))) {
      const record = readJson(join(this.recordsDir, name));
      const manager = record.manager = SessionManager.open(record.file, this.sessionsDir);
      // The append-only Pi journal wins if a process died between writing an
      // entry and replacing its discovery metadata file.
      record.focus = manager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "cloud-workspace")?.data.focus ?? record.focus;
      const storedModel = manager.buildSessionContext().model;
      if (storedModel) record.model = `${storedModel.provider}/${storedModel.modelId}`;
      record.epoch++;
      record.sequence = 0;
      if (record.status === "running") this.recover(record);
      this.records.set(record.id, record);
      this.save(record);
    }
    } catch (error) { this.releaseLock(); throw error; }
  }

  recover(record) {
    const manager = this.manager(record);
    const completed = manager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "cloud-turn" && entry.data.id === record.currentTurn?.id);
    if (completed) {
      const { id, ...outcome } = completed.data;
      record.turns[id] = outcome;
      record.status = outcome.status === "completed" ? "idle" : outcome.status;
      delete record.currentTurn;
      if (record.pendingFocus) this.applyFocus(record, record.pendingFocus);
      return;
    }
    const outstanding = new Map();
    for (const message of manager.buildSessionContext().messages) {
      if (message.role === "assistant") for (const block of message.content) {
        if (block.type === "toolCall") outstanding.set(block.id, block.name);
      }
      if (message.role === "toolResult") outstanding.delete(message.toolCallId);
    }
    for (const [id, name] of outstanding) manager.appendMessage({
      role: "toolResult", toolCallId: id, toolName: name, isError: true, timestamp: Date.now(),
      content: [{ type: "text", text: "Cloud process stopped before the result was recorded. The operation may have executed; inspect its effects before retrying." }],
    });
    manager.appendCustomMessageEntry("cloud-interrupted", "The cloud service restarted during the previous task. Its final outcome is unknown. No commands have been replayed.", true, { turn: record.currentTurn });
    record.status = "interrupted";
    if (record.currentTurn) {
      record.turns[record.currentTurn.id] = { status: "interrupted", error: "Cloud service restarted; inspect effects before retrying" };
      manager.appendCustomEntry("cloud-turn", { id: record.currentTurn.id, ...record.turns[record.currentTurn.id] });
    }
    delete record.currentTurn;
    record.manager = manager;
    if (record.pendingFocus) this.applyFocus(record, record.pendingFocus);
  }

  save(record) {
    const fields = ["id", "file", "focus", "origin", "pendingFocus", "parentId", "title", "model", "created", "modified", "status", "epoch", "turns", "currentTurn"];
    writeJson(join(this.recordsDir, `${record.id}.json`), Object.fromEntries(fields.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])));
  }
  get(id) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown cloud session: ${id}`);
    return record;
  }
  manager(record) { return record.manager ??= SessionManager.open(record.file, this.sessionsDir); }
  info(record) {
    const projection = this.manager(record).buildSessionContext();
    return {
      id: record.id, title: record.title, created: record.created, modified: record.modified,
      focus: record.focus, workspace: this.environment.get(record.focus).context?.binding ?? this.environment.get(record.focus),
      pendingFocus: record.pendingFocus, parentId: record.parentId, status: record.status,
      controller: record.controller ? { name: record.controller.name, connection: record.controller.id } : null,
      epoch: record.epoch, model: projection.model,
    };
  }
  snapshot(record, client) {
    return {
      ...this.info(record), sequence: record.sequence ?? 0,
      canInput: record.controller === client,
      messages: this.manager(record).buildSessionContext().messages,
      entries: this.manager(record).getEntries(),
      activeMessage: record.agent?.liveMessage ?? null,
      activeTools: [...record.agent?.liveTools.values() ?? []],
      currentTurn: record.currentTurn, turns: record.turns,
      environment: this.environment.list(),
    };
  }
  send(client, value) {
    if (client.socket.destroyed) return;
    // A stopped reader must not retain unlimited token output in server memory.
    if (client.socket.writableLength > 8 * 1024 * 1024) { client.socket.destroy(); return; }
    client.socket.write(JSON.stringify(value) + "\n");
  }
  publish(record, event) {
    const value = { type: "event", session: record.id, sequence: record.sequence = (record.sequence ?? 0) + 1, event };
    for (const client of this.clients) if (client.session === record.id) this.send(client, value);
  }
  changed(record) { this.publish(record, { type: "session_state", ...this.info(record) }); }
  release(client) {
    if (!client.session) return;
    const record = this.get(client.session);
    delete client.session;
    if (record.controller === client) {
      record.controller = null;
      record.epoch++;
      this.save(record);
      this.changed(record);
    }
  }
  authorize(client, record, epoch) {
    if (client.session !== record.id || record.controller !== client || epoch !== record.epoch) {
      throw new Error("Input control changed. Resume/take control and sync the current epoch before sending commands.");
    }
  }
  claim(client, record) {
    record.controller = client;
    record.epoch++;
    this.save(record);
    this.changed(record);
  }
  create(focus) {
    const entry = this.environment.get(focus);
    if (entry.kind === "mcp") throw new Error("A session's default workspace must be a directory");
    let manager = SessionManager.create(this.environment.get("cloud").workspace, this.sessionsDir);
    manager.appendCustomEntry("cloud-workspace", { focus, binding: entry.context?.binding });
    manager = persistInitial(manager);
    const record = {
      id: manager.getSessionId(), file: manager.getSessionFile(), manager,
      focus, origin: focus, title: "New cloud session", created: new Date().toISOString(), modified: new Date().toISOString(),
      status: "idle", epoch: 0, sequence: 0, turns: {}, ...(this.options.model ? { model: this.options.model } : {}),
    };
    this.records.set(record.id, record);
    this.save(record);
    return record;
  }
  applyFocus(record, focus) {
    const entry = this.environment.get(focus);
    if (entry.kind === "mcp") throw new Error("Choose a directory workspace");
    delete record.pendingFocus;
    if (record.focus === focus) return;
    const previous = record.focus;
    record.focus = focus;
    const manager = this.manager(record);
    manager.appendCustomEntry("cloud-workspace", { focus, previous, binding: entry.context?.binding });
    manager.appendCustomMessageEntry("workspace-changed", `Default workspace changed from ${previous} to ${focus} (${entry.context?.binding?.uri ?? entry.workspace}). Historical paths retain their original machine.`, true, { previous, focus });
    record.reloadAgent = true;
    record.modified = new Date().toISOString();
  }
  async agent(record) {
    if (record.agent && (record.reloadAgent || record.agent.version !== this.environment.version)) {
      await record.agent.close();
      record.agent = null;
    }
    if (!record.agent) record.agent = await createCloudAgent({
      environment: this.environment, manager: this.manager(record),
      agentDir: this.options.agentDir, modelRuntime: this.modelRuntime, model: record.model,
      onEvent: (event) => this.publish(record, event),
    });
    record.reloadAgent = false;
    return record.agent;
  }

  startTurn(client, record, request) {
    this.authorize(client, record, request.epoch);
    if (typeof request.turnId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.turnId)) throw new Error("Provide a unique turnId");
    if (record.turns[request.turnId]) return { turnId: request.turnId, ...record.turns[request.turnId], duplicate: true };
    if (record.status === "running") throw new Error("The session is running. Cancel it or wait before submitting another task.");
    if (request.command === "prompt" && (typeof request.text !== "string" || !request.text.trim())) throw new Error("Prompt must contain text");
    if (request.command === "tool" && (typeof request.name !== "string" || !request.args || typeof request.args !== "object" || Array.isArray(request.args))) throw new Error("Provide a tool name and arguments object");
    record.status = "running";
    record.currentTurn = { id: request.turnId, focus: record.focus, command: request.command };
    record.turns[request.turnId] = { status: "running" };
    record.modified = new Date().toISOString();
    if (request.command === "prompt" && record.title === "New cloud session") record.title = request.text.slice(0, 100);
    record.turnController = new AbortController();
    this.save(record);
    this.changed(record);
    record.task = this.runTurn(record, request, record.currentTurn.focus, record.turnController.signal);
    return { turnId: request.turnId, status: "running" };
  }
  async runTurn(record, request, focus, signal) {
    let completion;
    try {
      const agent = await this.agent(record);
      await agent.prepare(focus, signal);
      signal.throwIfAborted();
      const result = request.command === "prompt"
        ? await agent.prompt(request.text, request.images, signal)
        : await agent.execute(request.name, request.args, signal);
      signal.throwIfAborted();
      completion = { status: "completed", result };
    } catch (error) {
      completion = { status: signal.aborted ? "cancelled" : "failed", error: error.message };
    }
    record.turns[request.turnId] = completion;
    // Retain recent outcomes for reconnect/idempotency. Aged IDs are rejected
    // rather than replayed, using the append-only turn journal below.
    this.manager(record).appendCustomEntry("cloud-turn", { id: request.turnId, ...completion });
    while (Object.keys(record.turns).length > 32) delete record.turns[Object.keys(record.turns)[0]];
    record.status = completion.status === "completed" ? "idle" : completion.status;
    delete record.currentTurn;
    delete record.turnController;
    record.modified = new Date().toISOString();
    if (record.pendingFocus) this.applyFocus(record, record.pendingFocus);
    this.save(record);
    this.publish(record, { type: "turn_complete", turnId: request.turnId, ...completion });
    this.changed(record);
  }

  fork(record, entryId, focus) {
    if (record.status === "running") throw new Error("Wait for this turn to finish or cancel it before forking");
    const manager = SessionManager.open(record.file, this.sessionsDir);
    entryId ??= manager.getLeafId();
    if (!manager.getEntry(entryId)) throw new Error(`Unknown history entry: ${entryId}`);
    const outstanding = new Set();
    for (const entry of manager.getBranch(entryId)) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") outstanding.add(block.id);
      if (message.role === "toolResult") outstanding.delete(message.toolCallId);
    }
    if (outstanding.size) throw new Error("Choose a history point after all tool results have been recorded");
    manager.createBranchedSession(entryId);
    const historicalFocus = manager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "cloud-workspace")?.data.focus ?? record.origin;
    const child = {
      id: manager.getSessionId(), file: manager.getSessionFile(), manager: persistInitial(manager),
      focus: historicalFocus, origin: historicalFocus, parentId: record.id,
      title: `${record.title} (fork)`, created: new Date().toISOString(), modified: new Date().toISOString(),
      status: "idle", epoch: 0, sequence: 0, turns: {}, model: record.model,
    };
    child.manager.appendCustomEntry("cloud-fork", { parent: record.id, entry: entryId });
    if (focus) this.applyFocus(child, focus);
    this.records.set(child.id, child);
    this.save(child);
    return child;
  }

  async request(client, request) {
    if (this.closing) throw new Error("Cloud service is stopping");
    switch (request.command) {
      case "hello": {
        client.name = typeof request.name === "string" ? request.name.slice(0, 100) : client.name;
        if (request.workspaceId) {
          this.environment.get(request.workspaceId);
          client.homeWorkspace = request.workspaceId;
        } else if (request.machine && request.workspace) {
          client.homeWorkspace = await this.environment.register(request.machine, request.workspace);
        } else client.homeWorkspace = "cloud";
        return { connection: client.id, workspace: client.homeWorkspace, environment: this.environment.list() };
      }
      case "environment": return this.environment.list();
      case "list": return [...this.records.values()]
        .filter((record) => request.all || record.focus === client.homeWorkspace)
        .sort((a, b) => b.modified.localeCompare(a.modified)).map((record) => this.info(record));
      case "attach": {
        const record = request.session ? this.get(request.session) : this.create(client.homeWorkspace ?? "cloud");
        if (request.useCurrentWorkspace && this.environment.get(client.homeWorkspace ?? "cloud").kind === "mcp") throw new Error("Choose a directory workspace");
        this.release(client);
        client.session = record.id;
        if (request.mode !== "view") this.claim(client, record);
        if (request.useCurrentWorkspace) {
          this.authorize(client, record, record.epoch);
          if (record.status === "running") record.pendingFocus = client.homeWorkspace;
          else this.applyFocus(record, client.homeWorkspace);
          this.save(record); this.changed(record);
        }
        return this.snapshot(record, client);
      }
      case "detach": this.release(client); return {};
      case "snapshot": {
        const record = this.get(client.session);
        return this.snapshot(record, client);
      }
      case "take_control": {
        const record = this.get(client.session);
        this.claim(client, record);
        return this.snapshot(record, client);
      }
      case "prompt": case "tool": {
        const record = this.get(client.session);
        // A turn outside the recent outcome cache must never execute again.
        this.authorize(client, record, request.epoch);
        if (!record.turns[request.turnId] && this.manager(record).getEntries().some((entry) => entry.type === "custom" && entry.customType === "cloud-turn" && entry.data.id === request.turnId)) {
          throw new Error("This turnId has already been used; inspect history instead of replaying it");
        }
        return this.startTurn(client, record, request);
      }
      case "turn": {
        const record = this.get(client.session);
        return record.turns[request.turnId] ?? { status: "unknown" };
      }
      case "cancel": {
        const record = this.get(client.session);
        this.authorize(client, record, request.epoch);
        record.turnController?.abort();
        return { cancelling: record.status === "running" };
      }
      case "workspace": {
        const record = this.get(client.session);
        this.authorize(client, record, request.epoch);
        const focus = request.workspaceId === "current" ? client.homeWorkspace : request.workspaceId;
        if (this.environment.get(focus).kind === "mcp") throw new Error("Choose a directory workspace");
        if (record.status === "running") record.pendingFocus = focus;
        else this.applyFocus(record, focus);
        this.save(record); this.changed(record);
        return this.snapshot(record, client);
      }
      case "fork": {
        const source = this.get(client.session);
        this.authorize(client, source, request.epoch);
        const focus = request.useCurrentWorkspace ? client.homeWorkspace : undefined;
        const child = this.fork(source, request.entryId, focus);
        this.release(client); client.session = child.id; this.claim(client, child);
        return this.snapshot(child, client);
      }
      case "set_model": {
        const record = this.get(client.session);
        this.authorize(client, record, request.epoch);
        if (record.status === "running") throw new Error("Wait for the current turn before changing models");
        const split = request.model?.indexOf("/");
        const model = split > 0 ? this.modelRuntime.getModel(request.model.slice(0, split), request.model.slice(split + 1)) : undefined;
        if (!model) throw new Error("Unknown model");
        record.model = request.model;
        this.manager(record).appendModelChange(model.provider, model.id);
        record.reloadAgent = true;
        this.save(record); this.changed(record);
        return this.snapshot(record, client);
      }
      default: throw new Error(`Unknown cloud command: ${request.command}`);
    }
  }

  async start() {
    const agentDir = resolve(this.options.agentDir ?? getAgentDir());
    this.modelRuntime = this.options.modelRuntime ?? await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    await this.environment.refresh("cloud");
    for (const [id, entry] of this.environment.entries) if (entry.kind === "mcp") await this.environment.refresh(id);
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    this.server = createServer((socket) => {
      const client = { id: randomUUID(), name: "Terminal", socket };
      this.clients.add(client);
      const input = createInterface({ input: socket, crlfDelay: Infinity });
      input.on("error", () => socket.destroy());
      // Sequential requests on one connection keep hello/attach/mutations ordered.
      let chain = Promise.resolve();
      input.on("line", (line) => {
        chain = chain.then(async () => {
          if (socket.destroyed) return;
          let request;
          try {
            request = JSON.parse(line);
            if (!request || typeof request.id !== "string") throw new Error("Provide a request id");
            const result = await this.request(client, request);
            this.send(client, { type: "response", id: request.id, result });
          } catch (error) { this.send(client, { type: "response", id: request?.id, error: error.message }); }
        });
      });
      socket.on("error", () => {});
      socket.once("close", () => { input.close(); this.release(client); this.clients.delete(client); });
    });
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.socketPath, resolve); });
    chmodSync(this.socketPath, 0o600);
    return this;
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    for (const record of this.records.values()) record.turnController?.abort();
    await Promise.allSettled([...this.records.values()].map((record) => record.task));
    await Promise.allSettled([...this.records.values()].map((record) => record.agent?.close()));
    await this.environment.close();
    for (const client of this.clients) client.socket.destroy();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    this.releaseLock();
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: "string" }, python: { type: "string" }, model: { type: "string" },
    "state-dir": { type: "string" }, "agent-dir": { type: "string" }, "cloud-workspace": { type: "string" },
  } });
  const service = new CloudService({ ...values, stateDir: values["state-dir"], agentDir: values["agent-dir"], cloudWorkspace: values["cloud-workspace"] });
  try { await service.start(); } catch (error) { await service.close(); throw error; }
  console.error(`Cloud sessions ready: ${service.socketPath}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void service.close().catch((error) => { console.error(error.message); process.exitCode = 1; }); });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

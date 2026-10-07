/** DSH owns conversations; this plugin owns their execution bindings and input leases. */
import z from "@deepseek-ai/schemastery";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { createMcpToolDefinition } from "@deepseek-ai/dsh-mcp-client";
import { Session } from "@deepseek-ai/dsh-session";
import { z as schema } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { Environment, readJson, writeJson } from "../../environment.mjs";

export const name = "remote-workspaces";
export const inject = ["agents", "sessions", "sessionController", "sessionProjections", "tools", "systemPrompt", "workspaceFiles", "workspaceRegistry"];
export const Config = z.object({ stateDir: z.string().required(), targets: z.string().required(), python: z.string().required(), cloudWorkspace: z.string().required() });
const eventType = "remote/workspace";
const bindingSchema = schema.object({ id: schema.string(), machine: schema.string(), workspace: schema.string(), hostname: schema.string().optional() });
const projectionSchema = schema.object({ current: bindingSchema.nullable(), pending: bindingSchema.nullable(), revision: schema.number().int().nonnegative() });
const invocationInitializers = [];

function fail(message) { throw new RemoteError("gateway/bad-request", message, {}); }
function checkRequest(request) { if (!request || typeof request !== "object" || Array.isArray(request)) fail("Invalid request"); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

export class RemoteWorkspaces extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, "remoteWorkspaces");
    for (const initializer of invocationInitializers) initializer.call(this);
    this.host = ctx;
    this.stateDir = resolve(config.stateDir);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.anchorsFile = join(this.stateDir, "anchors.json");
    this.anchors = readJson(this.anchorsFile, {});
    this.environment = new Environment({ stateDir: this.stateDir, config: config.targets, python: config.python, cloudWorkspace: config.cloudWorkspace });
    this.leases = new Map();
    this.authorized = new AsyncLocalStorage();
    this.operations = new Map();
    this.connectionChecks = new Map();
    this.checkingConnections = new Map();
    ctx.effect(() => () => this.environment.close(), "remote: transports");
    ctx.sessionProjections.register({
      key: "remoteBinding", stateVersion: 1, stateSchema: projectionSchema,
      init: (header) => ({ current: this.anchors[header.cwd] ?? (header.cwd === this.environment.get("cloud").workspace ? this.binding("cloud") : null), pending: null, revision: 0 }),
      apply: (state, event) => event.type === eventType ? event.data : state,
      wire: { viewSchema: projectionSchema, view: (state) => state },
    });
    const controlSchema = schema.object({ clientId: schema.string(), label: schema.string() }).nullable();
    ctx.sessionProjections.register({ key: "remoteController", stateVersion: 1, stateSchema: controlSchema, init: () => null,
      apply: (state, event) => event.type === "remote/controller" ? event.data : state,
      wire: { viewSchema: controlSchema, view: (state) => state } });
    ctx.on("agent/created", async ({ agent }) => {
      const state = this.state(agent.session);
      if (!state.current) return;
      // Restart recovery applies a persisted pending switch before any new turn.
      if (state.pending) this.commit(agent, state.pending);
    });
    ctx.on("session/event", (session, event) => {
      if (event.type !== "turn/end") return;
      // Session forbids append reentrancy. The microtask runs after publication
      // and before the driver's next awaited turn, including its queued prompts.
      queueMicrotask(() => {
        if (ctx.sessions.get(session.id) !== session) return;
        const state = this.state(session);
        if (state.pending) this.commitSession(session, state.pending);
      });
    });
    // The preset suppresses native runtime snapshots, whose local cwd describes
    // the cloud host. Keep the authoritative target in the actual system prompt.
    const workspacePrompt = ({ agent }) => {
      if (!agent) return "";
      const state = this.state(agent.session);
      if (!state.current) return "";
      const { current } = state;
      const entry = this.environment.get(current.id);
      const context = entry.context;
      return [
        "Current execution environment (authoritative for this request):",
        `Machine: ${current.machine}${context ? ` (${context.hostname})` : ""}`,
        `Workspace: ${current.workspace}`,
        `Binding revision: ${state.revision}. This conversation can move between machines without losing history.`,
        "read/write/edit/bash/grep/find/ls execute on the CURRENT machine. Relative paths start in the CURRENT workspace.",
        "Earlier messages and tool results may refer to a previous machine. Recheck files after switching. Never silently fall back to the cloud or another machine when the target is unavailable.",
        "Use the environment tool to inspect or explicitly call other registered machines, cloud workspaces, or MCP services. This does not change the conversation's default workspace.",
        entry.lastError ? `Target connection error: ${entry.lastError}` : "",
        context?.git ? `Current Git state:\n${JSON.stringify(context.git)}` : "",
        ...(context?.agents_files ?? []).map((file) => `Project instructions from ${current.machine}:${file.path}:\n${file.content}`),
      ].filter(Boolean).join("\n\n");
    };
    ctx.systemPrompt.section({ name: "remote-workspace", order: 10, interpolate: false, text: workspacePrompt });
    ctx.on("system-prompt/assemble", async (assembly, context, next) => {
      const state = this.state(context.agent?.session);
      if (state.current) await this.environment.refresh(state.current.id, context.signal);
      const result = await next();
      // DSH assembles before agent/pre-step. Replace this section after the
      // async refresh so the very next request includes the latest facts.
      return { ...result, sections: result.sections.map((section) => section.name === "remote-workspace" ? { ...section, text: workspacePrompt(context) } : section) };
    });
    for (const descriptor of this.environment.manifest) {
      ctx.tools.register(createMcpToolDefinition(ctx, {
        ...descriptor, rawName: descriptor.name,
        call: async (args, execution) => {
          const state = this.state(execution.agent?.session);
          if (!state.current) throw new Error("Select a remote workspace first");
          return this.callTool(state.current.id, descriptor.name, args, execution.signal);
        },
      }));
    }
    ctx.tools.register(createMcpToolDefinition(ctx, {
      name: "environment", rawName: "environment",
      description: "Inspect the shared machine ecosystem or explicitly call a registered workspace/MCP tool. list returns target IDs and tool schemas; call executes the specified tool on that target without changing this session's default machine.",
      inputSchema: { type: "object", properties: { action: { enum: ["list", "call"] }, target: { type: "string" }, tool: { type: "string" }, args: { type: "object" } }, required: ["action"], additionalProperties: false },
      call: async (args, execution) => {
        if (args.action === "call") return this.callTool(args.target, args.tool, args.args ?? {}, execution.signal);
        await Promise.allSettled(this.environment.list().filter((target) => target.kind === "mcp").map((target) => this.environment.connect(target.id)));
        execution.signal?.throwIfAborted();
        const data = this.environment.list().map((target) => ({ ...target, tools: this.environment.descriptors(target.id) }));
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    }));
    this.installFileRouting();
    this.installInputGuard();
  }

  binding(id) {
    const entry = this.environment.get(id);
    return { id, machine: entry.machine, workspace: entry.workspace, hostname: entry.context?.hostname ?? (entry.machine === "cloud" ? hostname() : entry.machine) };
  }
  workspaceTitle(binding) {
    return `${this.binding(binding.id).hostname} · ${basename(binding.workspace) || "/"}`;
  }
  async updateWorkspaceTitle(workspace, binding) {
    // Retitle generated names, including rows left by the former split flow.
    // A user's explicit native rename remains their own choice.
    if ([basename(workspace.path), `${binding.machine} · ${binding.workspace}`].includes(workspace.title)) {
      await workspace.setTitle(this.workspaceTitle(binding));
    }
  }
  async updateWorkspaceTitles() {
    for (const workspace of this.host.workspaceRegistry.list()) {
      const binding = this.anchors[workspace.path] ?? (workspace.path === this.environment.get("cloud").workspace ? this.binding("cloud") : null);
      if (binding) await this.updateWorkspaceTitle(workspace, binding);
    }
  }
  state(session) {
    return session ? this.host.sessionProjections.stateOf(session, "remoteBinding") : { current: null, pending: null, revision: 0 };
  }
  async agent(sessionId) {
    if (typeof sessionId !== "string") fail("Session ID is required");
    const result = await this.host.sessionController.resolveAgent(sessionId);
    if (result.error) throw result.error;
    return result.agent;
  }
  view(agent, clientId) {
    const lease = this.leases.get(agent.id);
    const state = this.state(agent.session);
    return { ...state, current: state.current ? { ...state.current, hostname: this.binding(state.current.id).hostname } : null,
      pending: state.pending ? { ...state.pending, hostname: this.binding(state.pending.id).hostname } : null,
      connection: state.current ? this.connectionState(state.current.id) : null,
      running: agent.status === "running", control: lease ? { mine: lease.clientId === clientId, label: lease.label, epoch: lease.clientId === clientId ? lease.epoch : null } : null };
  }
  requireControl(agent, request) {
    const lease = this.leases.get(agent.id);
    if (!lease || lease.clientId !== request.clientId || lease.epoch !== request.epoch) fail("此会话已由另一窗口接管。请点击“接管输入”后继续。");
  }
  commitSession(session, binding) {
    const state = this.state(session);
    session.append(eventType, { current: binding, pending: null, revision: state.revision + 1 }, { ignorable: true });
  }
  commit(agent, binding) { this.commitSession(agent.session, binding); }
  async checkpoint(agent) { await this.host.sessions.flush(agent.session); }
  async serialize(sessionId, operation) {
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.operations.set(sessionId, next);
    try { return await next; }
    finally { if (this.operations.get(sessionId) === next) this.operations.delete(sessionId); }
  }

  async catalog(request) {
    checkRequest(request);
    this.reloadTargets();
    const machines = [{ id: "cloud", label: "VPS4 · 云端", workspace: this.environment.get("cloud").workspace }, ...Object.entries(this.environment.configuration.targets ?? {}).map(([id, target]) => ({ id, label: target.label ?? id, workspace: target.workspace }))];
    for (const machine of machines) {
      machine.hostname = machine.id === "cloud" ? hostname() : [...this.environment.entries.values()].find((entry) => entry.machine === machine.id && entry.context?.hostname)?.context.hostname;
    }
    const savedWorkspaces = this.host.workspaceRegistry.list().flatMap((workspace) => {
      const binding = this.anchors[workspace.path] ?? (workspace.path === this.environment.get("cloud").workspace ? this.binding("cloud") : null);
      return binding && machines.some((machine) => machine.id === binding.machine) ? [{ ...this.binding(binding.id), title: workspace.title, workspaceId: workspace.id }] : [];
    });
    const services = Object.keys(this.environment.configuration.mcp ?? {}).map((id) => ({ id, tools: this.environment.descriptors(id).map((tool) => tool.name) }));
    return { machines, savedWorkspaces, services, tools: this.environment.manifest.map((tool) => tool.name), workspaces: this.environment.list() };
  }
  connectionState(id) {
    const checked = this.connectionChecks.get(id);
    if (this.checkingConnections.has(id)) return { ...checked, status: "checking" };
    const error = this.environment.get(id).lastError;
    if (error) return { ...checked, status: "unavailable", error };
    return checked && Date.now() - checked.checkedAt < 65000 ? checked : { status: "unknown" };
  }
  async probe(request) {
    checkRequest(request);
    const id = request.target;
    if (typeof id !== "string" || !["local", "ssh"].includes(this.environment.get(id).kind)) fail("Select a machine workspace to check its connection");
    if (this.checkingConnections.has(id)) return this.checkingConnections.get(id);
    const check = (async () => {
      const started = Date.now();
      const controller = new AbortController();
      let timer;
      try {
        // Check the real directory without executing a model turn, changing a
        // binding, or closing a connection shared by another session.
        await Promise.race([
          this.fileRequest(id, { op: "stat", path: "." }, controller.signal),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("连接检查超时，请稍后重试。")); }, 12000); }),
        ]);
        const entry = this.environment.get(id);
        if (entry.lastError) { delete entry.lastError; this.environment.save(); }
        const result = { status: "online", checkedAt: Date.now(), latencyMs: Date.now() - started };
        this.connectionChecks.set(id, result);
        return result;
      } catch (error) {
        const result = { status: "unavailable", checkedAt: Date.now(), error: errorMessage(error) };
        this.connectionChecks.set(id, result);
        return result;
      } finally { clearTimeout(timer); }
    })();
    this.checkingConnections.set(id, check);
    try { return await check; }
    finally { if (this.checkingConnections.get(id) === check) this.checkingConnections.delete(id); }
  }
  async browse(request, signal) {
    checkRequest(request);
    this.reloadTargets();
    const id = await this.environment.register(request.machine, "/");
    return this.fileRequest(id, { op: "list", ...(request.path ? { path: request.path } : {}) }, signal);
  }
  async pick(request, signal) {
    checkRequest(request);
    this.reloadTargets();
    const id = await this.environment.register(request.machine, request.workspace);
    await this.preflight(id, signal);
    signal.throwIfAborted();
    const cwd = id === "cloud" ? this.environment.get("cloud").workspace : join(this.stateDir, "workspaces", id, "workspace");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const binding = this.binding(id);
    this.anchors[cwd] = binding;
    writeJson(this.anchorsFile, this.anchors);
    const workspace = await this.host.workspaceRegistry.create(cwd, this.workspaceTitle(binding));
    await this.updateWorkspaceTitle(workspace, binding);
    return { cwd, binding, workspaceId: workspace.id, title: workspace.title };
  }
  async get(request) {
    checkRequest(request);
    return this.view(await this.agent(request.sessionId), request.clientId);
  }
  async control(request) {
    checkRequest(request);
    if (typeof request.clientId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(request.clientId)) fail("Invalid controller identity");
    const agent = await this.agent(request.sessionId);
    return this.serialize(agent.id, async () => {
      const current = this.leases.get(agent.id);
      if (!current || current.clientId === request.clientId || request.takeover === true) {
        if (!current || current.clientId !== request.clientId) {
          const lease = { clientId: request.clientId, label: String(request.label ?? "Web 窗口").slice(0, 80), epoch: randomUUID() };
          this.leases.set(agent.id, lease);
          agent.session.append("remote/controller", { clientId: lease.clientId, label: lease.label }, { ignorable: true });
          await this.checkpoint(agent);
        }
      }
      return this.view(agent, request.clientId);
    });
  }
  async switch(request, signal) {
    checkRequest(request);
    const agent = await this.agent(request.sessionId);
    this.requireControl(agent, request);
    this.reloadTargets();
    const id = await this.environment.register(request.machine, request.workspace);
    // SSH/bootstrap can be slow. Keep cancel/takeover responsive while it runs,
    // then fence the actual switch against both the lease and binding revision.
    await this.preflight(id, signal);
    signal.throwIfAborted();
    return this.serialize(agent.id, async () => {
      signal.throwIfAborted();
      this.requireControl(agent, request);
      const state = this.state(agent.session);
      if (state.revision !== request.revision) fail("工作区已被更新，请刷新选择后再试。");
      const binding = this.binding(id);
      if (agent.status === "running") agent.session.append(eventType, { ...state, pending: binding, revision: state.revision + 1 }, { ignorable: true });
      else await agent.runMaintenance(async () => { this.commit(agent, binding); await this.checkpoint(agent); });
      await this.checkpoint(agent);
      return this.view(agent, request.clientId);
    });
  }
  async discardSwitch(request) {
    checkRequest(request);
    const agent = await this.agent(request.sessionId);
    return this.serialize(agent.id, async () => {
      this.requireControl(agent, request);
      const state = this.state(agent.session);
      agent.session.append(eventType, { ...state, pending: null, revision: state.revision + 1 }, { ignorable: true });
      await this.checkpoint(agent);
      return this.view(agent, request.clientId);
    });
  }
  async input(request, signal) {
    checkRequest(request);
    const allowed = ["prompt", "cancel", "updateQueue", "selectModel", "rename"];
    if (!allowed.includes(request.method)) fail("Unsupported session operation");
    const agent = await this.agent(request.payload?.sessionId);
    return this.serialize(agent.id, async () => {
      this.requireControl(agent, request);
      return this.authorized.run(agent.id, () => this.host.sessionController[request.method](request.payload, signal));
    });
  }
  installInputGuard() {
    for (const method of ["prompt", "cancel", "updateQueue", "selectModel", "rename"]) {
      const controller = this.host.sessionController;
      const original = controller[method];
      const service = this;
      const guarded = async function(request, signal) {
        const agent = await service.agent(request.sessionId);
        if (service.state(agent.session).current && service.authorized.getStore() !== agent.id) fail("Remote sessions require an input controller");
        return original.call(this, request, signal);
      };
      controller[method] = guarded;
      this.host.effect(() => () => { if (controller[method] === guarded) controller[method] = original; }, `remote: guard ${method}`);
    }
  }
  async callTool(id, name, args, signal) {
    await this.environment.connect(id);
    signal?.throwIfAborted();
    const descriptor = this.environment.descriptors(id).find((tool) => tool.name === name);
    if (!descriptor) throw new Error(`Unknown tool ${name} on ${id}`);
    const result = await this.environment.definition(id, descriptor).execute(randomUUID(), args, signal);
    return { content: result.content, ...(result.details?.structuredContent ? { structuredContent: result.details.structuredContent } : {}) };
  }
  reloadTargets() { this.environment.configuration = readJson(this.environment.config, {}); }
  async preflight(id, signal) {
    // A cached outer MCP connection may outlive its SSH target. Reading context
    // proves that the selected workspace is available before changing binding.
    await this.environment.refresh(id, signal);
    const error = this.environment.get(id).lastError;
    if (error) throw new Error(error);
  }
  async fileRequest(id, request, signal) {
    const connection = await this.environment.connect(id);
    const uri = `workspace://files?request=${encodeURIComponent(JSON.stringify(request))}`;
    try {
      const result = await connection.client.readResource({ uri }, { signal, timeout: 15000 });
      return JSON.parse(result.contents[0].text);
    } catch (error) {
      // Evict only a closed transport, and only its own generation. A bad file
      // path or per-request cancellation must leave other sessions' tools alone.
      if (!signal?.aborted && (error.code === -32000 || !connection.client.transport) && this.environment.connections.get(id) === connection) await this.environment.disconnect(id);
      throw error;
    }
  }
  async scopeBinding(scope) {
    const agent = await this.agent(scope.sessionId);
    return this.state(agent.session).current;
  }
  async routeFile(scope, path, request, signal) {
    const binding = await this.scopeBinding(scope);
    const legacyRoot = scope.workspaceRoot;
    if (isAbsolute(path) && (path === legacyRoot || path.startsWith(legacyRoot + "/"))) path = join(binding.workspace, relative(legacyRoot, path));
    return this.fileRequest(binding.id, { ...request, path }, signal);
  }
  installFileRouting() {
    const files = this.host.workspaceFiles;
    const service = this;
    const replacements = {
      async list(scope, path, signal) { const result = await service.routeFile(scope, path, { op: "list" }, signal); return { path: result.path, entries: result.entries, truncated: result.truncated }; },
      async read(scope, path, range, signal) { return service.routeFile(scope, path, { op: "text", ...range }, signal); },
      async stat(scope, path, signal) { const { absolutePath, version, bytes } = await service.routeFile(scope, path, { op: "stat" }, signal); return { absolutePath, version, bytes }; },
      async readBytes(scope, path, options, signal) {
        if (options.baseFile) {
          if (isAbsolute(path)) fail("Linked preview paths must be relative");
          path = resolve(options.baseFile, "..", path);
        }
        const result = await service.routeFile(scope, path, { op: "bytes", offset: options.range?.offset, length: options.range?.length }, signal);
        const { base64, ...rest } = result;
        return { ...rest, data: Buffer.from(base64, "base64") };
      },
      async *changes(scope, path, signal) {
        yield { kind: "ready" };
        let previous;
        while (!signal.aborted) {
          try {
            const binding = await service.scopeBinding(scope);
            const info = await service.routeFile(scope, path, { op: "stat" }, signal);
            const fingerprint = `${binding.id}:${info.version}`;
            if (previous !== fingerprint) {
              previous = fingerprint;
              yield { kind: "change", change: { absolutePath: info.absolutePath, version: fingerprint } };
            }
          } catch (error) {
            if (signal.aborted) return;
            yield { kind: "change", change: { absolutePath: path, absent: true } };
          }
          try { await delay(2000, undefined, { signal }); } catch { return; }
        }
      },
    };
    for (const [method, replacement] of Object.entries(replacements)) {
      const original = files[method];
      const wrapped = method === "changes" ? async function*(scope, path, signal) {
        if (await service.scopeBinding(scope)) yield* replacement(scope, path, signal);
        else yield* original.call(this, scope, path, signal);
      } : async function(...args) {
        if (await service.scopeBinding(args[0])) return replacement(...args);
        return original.apply(this, args);
      };
      files[method] = wrapped;
      this.host.effect(() => () => { if (files[method] === wrapped) files[method] = original; }, `remote: file ${method}`);
    }
  }
}

// Native JS decorators keep this plugin on DSH's authenticated Typert RPC carrier.
for (const method of ["catalog", "browse", "pick", "get", "probe", "control", "switch", "discardSwitch", "input"]) {
  Remote(RemoteWorkspaces.prototype[method], { kind: "method", name: method, private: false, static: false, addInitializer: (initializer) => invocationInitializers.push(initializer) });
}

export async function apply(ctx, config) {
  if (Session.create("remote-compat-probe").append(eventType, {}, { ignorable: true }).ignorable !== true) throw new Error("Run dsh-product/patch-dsh.mjs before starting the remote Host");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(config.stateDir, { stale: 10000, update: 2000, retries: 0 });
  ctx.effect(() => release, "remote: single host");
  const service = new RemoteWorkspaces(ctx, config);
  await ctx.workspaceRegistry.initializeDefault(async () => service.environment.get("cloud").workspace);
  await service.updateWorkspaceTitles();
}

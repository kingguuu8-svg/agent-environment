/** DSH owns conversations; this plugin owns their execution bindings and input leases. */
import z from "@deepseek-ai/schemastery";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { createMcpToolDefinition } from "@deepseek-ai/dsh-mcp-client";
import { Session } from "@deepseek-ai/dsh-session";
import { z as schema } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import mime from "mime-types";
import { Environment, readJson, writeJson } from "../../environment.mjs";
import { maxBytes as workspaceFileByteLimit } from "../../workspace-files.mjs";
import { createPiToolDefinition } from "../pi-tool-result.mjs";

export const name = "remote-workspaces";
export const inject = ["agents", "sessions", "sessionController", "sessionProjections", "tools", "systemPrompt", "workspaceFiles", "workspaceRegistry", "fileReferences", "typert", "connection", "attachments"];
export const Config = z.object({ stateDir: z.string().required(), targets: z.string().required(), python: z.string().required(), cloudWorkspace: z.string().required() });
const eventType = "remote/workspace";
const handoffEventType = "remote/handoff";
const bindingSchema = schema.object({ id: schema.string(), machine: schema.string(), workspace: schema.string(), hostname: schema.string().optional() });
const projectionSchema = schema.object({ current: bindingSchema.nullable(), pending: bindingSchema.nullable(), revision: schema.number().int().nonnegative() });
const invocationInitializers = [];
const execute = promisify(execFile);
const historyScopePrefix = "remote-tool-file:";
const replyScopePrefix = "remote-reply-file:";
const fileToolNames = new Set(["read", "write", "edit"]);

function fail(message) { throw new RemoteError("gateway/bad-request", message, {}); }
function checkRequest(request) { if (!request || typeof request !== "object" || Array.isArray(request)) fail("Invalid request"); }
function checkController(request) { if (typeof request.clientId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(request.clientId)) fail("Invalid controller identity"); }
function newController(request) { return { clientId: request.clientId, label: String(request.label ?? "Web 窗口").slice(0, 80), epoch: randomUUID() }; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

export class RemoteWorkspaces extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, "remoteWorkspaces");
    for (const initializer of invocationInitializers) initializer.call(this);
    this.host = ctx;
    this.stateDir = resolve(config.stateDir);
    this.runtimeDir = dirname(resolve(config.targets));
    this.python = config.python;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.anchorsFile = join(this.stateDir, "anchors.json");
    this.anchors = readJson(this.anchorsFile, {});
    this.environment = new Environment({ stateDir: this.stateDir, config: config.targets, python: config.python, cloudWorkspace: config.cloudWorkspace });
    this.leases = new Map();
    this.authorized = new AsyncLocalStorage();
    this.operations = new Map();
    this.connectionChecks = new Map();
    this.checkingConnections = new Map();
    this.deviceChecks = new Map();
    ctx.effect(() => () => this.environment.close(), "remote: transports");
    ctx.sessionProjections.register({
      key: "remoteBinding", stateVersion: 2, stateSchema: projectionSchema,
      init: (header) => ({ current: this.anchors[header.cwd] ?? (header.cwd === this.environment.get("cloud").workspace ? this.binding("cloud") : null), pending: null, revision: 0 }),
      apply: (state, event) => event.type === eventType ? event.data : event.type === handoffEventType ? event.data.binding : state,
      wire: { viewSchema: projectionSchema, view: (state) => state },
    });
    const controlSchema = schema.object({ clientId: schema.string(), label: schema.string() }).nullable();
    ctx.sessionProjections.register({ key: "remoteController", stateVersion: 3,
      stateSchema: schema.object({ inheritedEventCount: schema.number().int().nonnegative(), controller: controlSchema }),
      init: (_header, inheritedEventCount) => ({ inheritedEventCount, controller: null }),
      // A branch borrows history, including controller events. Only events in
      // its own log can establish that independent session's input owner.
      apply: (state, event) => event.seq < state.inheritedEventCount ? state : event.type === "remote/controller" ? { ...state, controller: event.data } : event.type === handoffEventType ? { ...state, controller: event.data.controller } : state,
      wire: { viewSchema: controlSchema, view: (state) => state.controller } });
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
      ctx.tools.register(createPiToolDefinition(ctx, {
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
    this.installHistoricalFileScopes();
    this.installReplyImages();
    this.installReferenceRouting();
    this.installInputGuard();
  }

  binding(id) {
    const entry = this.environment.get(id);
    return { id, machine: entry.machine, workspace: entry.workspace, hostname: entry.context?.hostname ?? (entry.machine === "cloud" ? hostname() : entry.machine) };
  }
  workspaceTitle(binding) {
    return `${this.binding(binding.id).hostname} · ${basename(binding.workspace.replaceAll("\\", "/")) || "/"}`;
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
  controllerLease(agent) {
    let lease = this.leases.get(agent.id);
    if (!lease) {
      const saved = this.host.sessionProjections.stateOf(agent.session, "remoteController").controller;
      if (saved) {
        // Restore the window identity, while fencing requests from the previous
        // process with a fresh epoch. Reading as a viewer cannot claim ownership.
        lease = { ...saved, epoch: randomUUID() };
        this.leases.set(agent.id, lease);
      }
    }
    return lease;
  }
  view(agent, clientId) {
    const lease = this.controllerLease(agent);
    const state = this.state(agent.session);
    return { ...state, current: state.current ? { ...state.current, hostname: this.binding(state.current.id).hostname } : null,
      pending: state.pending ? { ...state.pending, hostname: this.binding(state.pending.id).hostname } : null,
      connection: state.current ? this.connectionState(state.current.id) : null,
      running: agent.status === "running", control: lease ? { mine: lease.clientId === clientId, label: lease.label, epoch: lease.clientId === clientId ? lease.epoch : null } : null };
  }
  requireControl(agent, request) {
    const lease = this.controllerLease(agent);
    if (!lease || lease.clientId !== request.clientId || lease.epoch !== request.epoch) fail("此会话已由另一窗口接管。请点击“接管输入”后继续。");
  }
  claimControl(agent, request) {
    if (this.controllerLease(agent)?.clientId === request.clientId) return false;
    const lease = newController(request);
    agent.session.append("remote/controller", { clientId: lease.clientId, label: lease.label }, { ignorable: true });
    this.leases.set(agent.id, lease);
    return true;
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
  async deviceInstaller(request, signal) {
    checkRequest(request);
    if (!["linux", "mac", "windows"].includes(request.platform ?? "linux")) fail("请选择 Linux、macOS 或 Windows");
    const { stdout } = await execute(this.python, [join(this.runtimeDir, "device_onboarding.py"), "create", "--runtime", this.runtimeDir, "--state", this.stateDir, "--platform", request.platform ?? "linux"], { signal, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  async deviceInstallerStatus(request, signal) {
    checkRequest(request);
    if (typeof request.pairingId !== "string" || !/^[a-f0-9]{32}$/.test(request.pairingId)) fail("Invalid pairing identity");
    const { stdout } = await execute(this.python, [join(this.runtimeDir, "device_onboarding.py"), "status", "--runtime", this.runtimeDir, "--state", this.stateDir, "--pairing", request.pairingId], { signal, timeout: 5000, maxBuffer: 65536 });
    const result = JSON.parse(stdout);
    if (result.phase !== "registered") return result;
    this.reloadTargets();
    const machine = result.machine;
    let check = this.deviceChecks.get(machine.id);
    const staleAfter = check?.value.status === "online" ? 65000 : 10000;
    if (!check || !check.promise && Date.now() - check.value.checkedAt >= staleAfter) {
      check = { value: { status: "checking", checkedAt: Date.now() } };
      this.deviceChecks.set(machine.id, check);
      // First bootstrap can take minutes. Share it across watching tabs and
      // return progress immediately; leaving a dialog preserves shared tools.
      check.promise = (async () => {
        try {
          const id = await this.environment.register(machine.id, machine.workspace);
          check.value = await this.probe({ target: id });
        } catch (error) { check.value = { status: "unavailable", checkedAt: Date.now(), error: errorMessage(error) }; }
      })().finally(() => { check.promise = null; });
    }
    return { ...result, connection: check.value };
  }
  async deviceInstallerConfirm(request, signal) {
    checkRequest(request);
    if (typeof request.pairingId !== "string" || !/^[a-f0-9]{32}$/.test(request.pairingId)) fail("Invalid pairing identity");
    if (typeof request.machine !== "string" || !/^[a-z][a-z0-9_]{0,47}$/.test(request.machine)) fail("Invalid device identity");
    const { stdout } = await execute(this.python, [join(this.runtimeDir, "device_onboarding.py"), "confirm", "--runtime", this.runtimeDir, "--state", this.stateDir, "--pairing", request.pairingId, "--machine", request.machine], { signal, timeout: 5000, maxBuffer: 65536 });
    return JSON.parse(stdout);
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
    const target = this.environment.configuration.targets?.[request.machine];
    const root = target?.platform === "windows" ? win32.parse(request.path || target.workspace).root : "/";
    if (!root) fail("请输入完整目录路径，例如 C:\\Users");
    const id = await this.environment.register(request.machine, root);
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
    checkController(request);
    const agent = await this.agent(request.sessionId);
    return this.serialize(agent.id, async () => {
      const current = this.controllerLease(agent);
      if (!current || current.clientId === request.clientId || request.takeover === true) {
        if (this.claimControl(agent, request)) await this.checkpoint(agent);
      }
      return this.view(agent, request.clientId);
    });
  }
  async switch(request, signal) {
    checkRequest(request);
    const agent = await this.agent(request.sessionId);
    const takeover = request.takeover === true;
    if (takeover) checkController(request);
    else this.requireControl(agent, request);
    const observedController = this.controllerLease(agent);
    if (this.state(agent.session).revision !== request.revision) fail("工作区已被更新，请刷新选择后再试。");
    this.reloadTargets();
    const id = await this.environment.register(request.machine, request.workspace);
    // SSH/bootstrap can be slow. Keep cancel/takeover responsive while it runs,
    // then fence the actual switch against both the lease and binding revision.
    await this.preflight(id, signal);
    signal.throwIfAborted();
    return this.serialize(agent.id, async () => {
      signal.throwIfAborted();
      if (takeover) {
        if (this.controllerLease(agent)?.epoch !== observedController?.epoch) fail("输入权已被其他窗口更新，请检查当前会话后再试。");
      } else this.requireControl(agent, request);
      const state = this.state(agent.session);
      if (state.revision !== request.revision) fail("工作区已被更新，请刷新选择后再试。");
      const binding = this.binding(id);
      const running = agent.status === "running";
      const commit = async () => {
        // One event saves both halves of a handoff. Preparation failures and a
        // partial log write cannot leave only the new controller persisted.
        if (takeover) {
          const lease = observedController?.clientId === request.clientId ? observedController : newController(request);
          const nextBinding = running ? { ...state, pending: binding, revision: state.revision + 1 } : { current: binding, pending: null, revision: state.revision + 1 };
          agent.session.append(handoffEventType, { controller: { clientId: lease.clientId, label: lease.label }, binding: nextBinding }, { ignorable: true });
          this.leases.set(agent.id, lease);
        } else if (running) agent.session.append(eventType, { ...state, pending: binding, revision: state.revision + 1 }, { ignorable: true });
        else this.commit(agent, binding);
        await this.checkpoint(agent);
      };
      if (running) await commit();
      else await agent.runMaintenance(commit);
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
    return { content: result.content,
      ...(this.environment.get(id).kind !== "mcp" ? { _meta: { "remote/pi": { ...result.details, origin: this.binding(id) } } } : {}),
      ...(result.details?.structuredContent ? { structuredContent: result.details.structuredContent } : {}) };
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
    if (scope.historicalBinding) return scope.historicalBinding;
    const agent = await this.agent(scope.sessionId);
    return this.state(agent.session).current;
  }
  async toolOrigin(request, signal) {
    checkRequest(request);
    if (![request.sessionId, request.callId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 1024)) fail("Invalid tool file identity");
    // Inspect is a cold read: previewing history must not activate an Agent or
    // apply a pending switch. Old logs can recover their origin at tool dispatch.
    const inspection = await this.host.sessionController.inspect(request.sessionId, signal);
    let current = this.anchors[inspection.meta.cwd] ?? (inspection.meta.cwd === this.environment.get("cloud").workspace ? this.binding("cloud") : null);
    let call, origin, result;
    for (const event of inspection.events) {
      if (event.type === eventType) current = event.data.current;
      else if (event.type === handoffEventType) current = event.data.binding.current;
      else if (event.type === "tool/call" && event.data.callId === request.callId) {
        if (call) fail("Ambiguous historical tool identity");
        call = event.data; origin = current;
      } else if (event.type === "tool/result" && event.data.message.toolCallId === request.callId) result = event.data;
    }
    if (!call || !fileToolNames.has(call.name)) fail("This history entry has no file preview");
    if (result?.message.isError) fail("A failed tool call has no successful file preview");
    const details = result?.meta?.remotePi;
    if (details?.origin) origin = details.origin;
    else if (details?.workspace && details.remote) origin = { id: details.workspace, machine: details.remote.machine, workspace: details.remote.workspace };
    return this.historicalFileOrigin(origin, historyScopePrefix + JSON.stringify([request.sessionId, request.callId]));
  }
  async replyOrigin(request, signal) {
    checkRequest(request);
    if (typeof request.sessionId !== "string" || !request.sessionId || request.sessionId.length > 1024 ||
        ![request.turn, request.step].every((value) => Number.isSafeInteger(value) && value >= 0)) fail("Invalid reply file identity");
    const inspection = await this.host.sessionController.inspect(request.sessionId, signal);
    let current = this.anchors[inspection.meta.cwd] ?? (inspection.meta.cwd === this.environment.get("cloud").workspace ? this.binding("cloud") : null);
    let started = false, hasReply = false, origin;
    for (const event of inspection.events) {
      if (event.type === eventType) current = event.data.current;
      else if (event.type === handoffEventType) current = event.data.binding.current;
      else if (event.data?.turn === request.turn && event.data?.step === request.step) {
        if (event.type === "step/start") {
          if (started) fail("Ambiguous historical reply identity");
          started = true; origin = current;
        } else if (event.type === "assistant/live-chunk" || event.type === "assistant/message" && event.surfaceOp === "append") hasReply = true;
      }
    }
    // The step's default workspace is authoritative for relative reply links,
    // even if that step explicitly called another target through environment.
    if (!started || !hasReply) fail("This history entry has no reply file preview");
    return this.historicalFileOrigin(origin, replyScopePrefix + JSON.stringify([request.sessionId, request.turn, request.step]));
  }
  historicalFileOrigin(origin, scopeId) {
    const parsed = bindingSchema.safeParse(origin);
    if (!parsed.success) fail("The original workspace is unavailable for this history entry");
    const entry = this.environment.get(parsed.data.id);
    if (entry.kind === "mcp" || entry.machine !== parsed.data.machine || entry.workspace !== parsed.data.workspace) fail("The original workspace identity has changed");
    return { binding: { ...parsed.data, hostname: parsed.data.hostname ?? entry.context?.hostname ?? parsed.data.machine },
      scopeId };
  }
  installHistoricalFileScopes() {
    const native = this.host.typert.lookups.get("workspaceFileScope");
    if (!native) throw new Error("The native workspace file scope is unavailable");
    this.host.typert.lookups.configure("workspaceFileScope", async (scopeId) => {
      const isReply = typeof scopeId === "string" && scopeId.startsWith(replyScopePrefix);
      if (!isReply && (typeof scopeId !== "string" || !scopeId.startsWith(historyScopePrefix))) return native.resolve(scopeId);
      let identity;
      try { identity = JSON.parse(scopeId.slice(isReply ? replyScopePrefix.length : historyScopePrefix.length)); } catch { fail("Invalid historical file scope"); }
      if (!Array.isArray(identity) || identity.length !== (isReply ? 3 : 2)) fail("Invalid historical file scope");
      const value = isReply ? await this.replyOrigin({ sessionId: identity[0], turn: identity[1], step: identity[2] }) :
        await this.toolOrigin({ sessionId: identity[0], callId: identity[1] });
      return { sessionId: identity[0], workspaceRoot: value.binding.workspace, historicalBinding: value.binding };
    });
  }
  installReplyImages() {
    // Register inside DSH's authenticated carrier, sharing the same cold reply
    // origin and bounded read-only target files as the native preview sidebar.
    this.host.effect(() => this.host.connection.fetch.register({
      path: "/api/remote-reply-image", methods: ["GET", "HEAD"], requestBody: "buffered",
      fetch: async (request) => {
        const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" };
        const failure = (status, message) => new Response(request.method === "HEAD" ? null : message, { status, headers });
        const query = new URL(request.url).searchParams;
        const path = query.get("path");
        let identity;
        try { identity = JSON.parse(query.get("reply")); } catch { return failure(400, "Invalid reply image identity"); }
        if (!Array.isArray(identity) || identity.length !== 3 || !path || path.length > 16384 || path.includes("\0")) return failure(400, "Invalid reply image request");
        try {
          const value = await this.replyOrigin({ sessionId: identity[0], turn: identity[1], step: identity[2] }, request.signal);
          const scope = { sessionId: identity[0], workspaceRoot: value.binding.workspace, historicalBinding: value.binding };
          const limit = Math.min(workspaceFileByteLimit, this.host.attachments.imageLimits.maxImageBytes);
          const info = await this.routeFile(scope, path, { op: "stat" }, request.signal);
          if (info.type !== "file") return failure(403, "Image preview requires a regular file");
          if (info.bytes > limit) return failure(413, "Image exceeds preview byte limit");
          headers["Content-Type"] = mime.lookup(info.absolutePath) || "application/octet-stream";
          if (request.method === "HEAD") { headers["Content-Length"] = String(info.bytes); return new Response(null, { headers }); }
          const result = await this.routeFile(scope, path, { op: "bytes", length: limit }, request.signal);
          if (!result.eof || result.bytes > limit) return failure(413, "Image exceeds preview byte limit");
          const bytes = Buffer.from(result.base64, "base64");
          headers["Content-Length"] = String(bytes.byteLength);
          return new Response(bytes, { headers });
        } catch { return failure(request.signal.aborted ? 499 : 404, "The original reply image is unavailable"); }
      },
    }), "remote: reply images");
  }
  installReferenceRouting() {
    const references = this.host.fileReferences;
    const original = references.list;
    const service = this;
    const routed = async function(agent, query, signal) {
      const current = service.state(agent.session).current;
      if (!current) return original.call(this, agent, query, signal);
      const candidates = await service.fileRequest(current.id, { op: "references", query }, signal);
      signal.throwIfAborted();
      // A query admitted before a handoff must not offer the former machine's
      // candidates after the session's default execution target has changed.
      return service.state(agent.session).current?.id === current.id ? candidates : [];
    };
    references.list = routed;
    this.host.effect(() => () => { if (references.list === routed) references.list = original; }, "remote: file reference routing");
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
for (const method of ["catalog", "deviceInstaller", "deviceInstallerStatus", "deviceInstallerConfirm", "browse", "pick", "get", "probe", "control", "switch", "discardSwitch", "input", "toolOrigin", "replyOrigin"]) {
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

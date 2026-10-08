/** Authenticated HTTP/MCP access to the Host's existing Environment instance. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { createServer } from "node:http";
import { readJson } from "./state-json.mjs";

const maxBodyBytes = 8 * 1024 * 1024;
const requestTimeoutMs = 180000;
const sessionIdleMs = 30 * 60 * 1000;
const inputSchema = {
  type: "object", additionalProperties: false, required: ["action"],
  properties: {
    action: { enum: ["list", "context", "workspace", "call"] },
    target: { type: "string", minLength: 1, maxLength: 80 },
    machine: { type: "string", minLength: 1, maxLength: 80 },
    workspace: { type: "string", minLength: 1, maxLength: 16384 },
    tool: { type: "string", minLength: 1, maxLength: 256 },
    args: { type: "object" },
  },
  allOf: [
    { if: { properties: { action: { const: "context" } } }, then: { required: ["target"] } },
    { if: { properties: { action: { const: "workspace" } } }, then: { required: ["machine", "workspace"] } },
    { if: { properties: { action: { const: "call" } } }, then: { required: ["target", "tool"] } },
  ],
};

class AccessError extends Error {
  constructor(status, code, message, execution = "not_started") {
    super(message);
    Object.assign(this, { status, code, execution });
  }
}

export function credentialHash(account, key) {
  return createHash("sha256").update(`${account}\0${key}`).digest("hex");
}

function configuration(file) {
  if (statSync(file).mode & 0o077) throw new Error("Environment access configuration must have permissions 600");
  const config = readJson(file);
  const url = new URL(config.url);
  if (config.version !== 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.account)
    || !/^[a-f0-9]{64}$/.test(config.credentialHash)
    || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Invalid environment access configuration");
  }
  return { ...config, url: url.origin + "/" };
}

function authenticate(header, config) {
  const encoded = typeof header === "string" && header.length <= 4096 && header.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i)?.[1];
  if (!encoded || config.enabled === false) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) return false;
  return timingSafeEqual(Buffer.from(credentialHash(decoded.slice(0, colon), decoded.slice(colon + 1)), "hex"), Buffer.from(config.credentialHash, "hex"));
}

function contract(url) {
  return {
    name: "Shared agent environment", version: 1,
    endpoints: { http: new URL("api/environment", url).href, mcp: new URL("mcp", url).href },
    authentication: { type: "HTTP Basic", username: "account", password: "key", credentialLocation: "Authorization header only" },
    instructions: [
      "Use your existing HTTP or terminal tool to call the HTTP endpoint. MCP is also available. Your own agent, conversation and local tools remain with your client.",
      "POST application/json with action=list first. It returns a compact catalog of machines, stable target IDs and tool names. Use only IDs returned by the service.",
      "Before working on a target, request action=context for its full tool input schemas. Check its machine, absolute workspace, Git state and agents_files project instructions. Apply those instructions only to that workspace.",
      "Every tool call explicitly specifies a target ID. Relative paths belong to that target's workspace; your local tools still operate on your own machine. A workspace is a working directory, and tools use the target login user's OS permissions.",
      "For another existing directory, use action=workspace with the machine ID and directory. This registers a workspace without creating, switching or taking over a DSH conversation. Then request its context.",
      "An unavailable target returns an error. Keep the requested target; never silently execute the operation on another machine.",
      "Calls are not automatically retried. A timeout or lost response can follow a completed or partially completed operation. Inspect the target's actual state before repeating any mutation. Other agents can operate on the same files concurrently.",
      "Use a client timeout of at least 200 seconds; server requests are bounded to 180 seconds and native tools retain their own time limits. Cancelling an HTTP request or an MCP tools/call cancels only that invocation.",
      "Keep the key private. Send it only to the stated HTTPS origin in Authorization; do not include it in URLs, tool arguments, project files or logs. A 401 requires valid credentials. New MCP connections must initialize before listing/calling tools.",
    ],
    inputSchema,
    examples: [
      { action: "list" },
      { action: "context", target: "<id from list>" },
      { action: "call", target: "<id from list>", tool: "read", args: { path: "README.md" } },
      { action: "workspace", machine: "<machine id from list>", workspace: "<existing absolute directory>" },
    ],
    limits: { maxBodyBytes, requestTimeoutMs, mcpSessionIdleMs: sessionIdleMs },
    errorFormat: { error: { code: "string", message: "string", execution: "not_started | may_have_executed", retry: "inspect_target_before_retry (for uncertain calls)" } },
  };
}

function send(response, status, data, extra = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extra });
  response.end(JSON.stringify(data));
}

function failure(error, execution = "not_started") {
  const code = error instanceof AccessError ? error.code : "environment_unavailable";
  const state = error instanceof AccessError ? error.execution : execution;
  return { error: { code, message: error.message ?? String(error), execution: state,
    ...(state === "may_have_executed" ? { retry: "inspect_target_before_retry" } : {}) } };
}

function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new AccessError(415, "content_type", "Use Content-Type: application/json");
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const cleanup = () => {
      request.off("data", data); request.off("end", end); request.off("error", rejectBody); request.off("aborted", aborted);
    };
    const rejectBody = (error) => { cleanup(); request.resume(); reject(error); };
    const aborted = () => rejectBody(new AccessError(499, "cancelled", "Request disconnected"));
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) return rejectBody(new AccessError(413, "body_too_large", "Request body exceeds 8 MiB"));
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new AccessError(400, "invalid_json", "Request body must be valid JSON")); }
    };
    request.on("data", data); request.on("end", end); request.on("error", rejectBody); request.on("aborted", aborted);
  });
}

function interruptible(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

export async function startEnvironmentAccess({ configFile, environment, callTool, reloadTargets }) {
  const initial = configuration(configFile);
  const publicOrigin = new URL(initial.url).origin;
  const allowedHosts = [new URL(initial.url).host, `127.0.0.1:${initial.port}`, `localhost:${initial.port}`];
  const sessions = new Map();
  const active = new Set();
  const validator = new AjvJsonSchemaValidator();
  const validateRequest = validator.getValidator(inputSchema);
  const info = contract(initial.url);
  const target = (id) => {
    const entry = environment.list().find((value) => value.id === id);
    if (!entry) throw new AccessError(404, "unknown_target", "Unknown target. Use action=list to obtain registered IDs.");
    return entry;
  };

  async function execute(input, signal) {
    signal.throwIfAborted();
    const validation = validateRequest(input);
    if (!validation.valid) throw new AccessError(400, "invalid_request", validation.errorMessage);
    reloadTargets();
    if (input.action === "list") {
      const targets = await interruptible(environment.discover(signal), signal);
      return { machines: [
        { id: "cloud", label: "VPS4", workspace: environment.get("cloud").workspace },
        ...Object.entries(environment.configuration.targets ?? {}).map(([id, item]) => ({ id, label: item.label ?? id, workspace: item.workspace })),
      ], targets: targets.map((entry) => ({ ...entry, tools: entry.tools.map((tool) => tool.name) })) };
    }
    if (input.action === "workspace") {
      if (input.machine !== "cloud" && !environment.configuration.targets?.[input.machine]) {
        throw new AccessError(404, "unknown_machine", "Unknown machine. Use action=list to obtain machine IDs.");
      }
      try {
        const id = await interruptible(environment.register(input.machine, input.workspace), signal);
        return { target: target(id), tools: environment.descriptors(id) };
      } catch (error) {
        if (signal.aborted) throw error;
        throw new AccessError(422, "workspace_unavailable", error.message);
      }
    }
    const entry = target(input.target);
    if (input.action === "context") {
      await interruptible(environment.refresh(input.target, signal), signal);
      const latest = environment.get(input.target);
      if (latest.lastError) throw new AccessError(503, "target_unavailable", latest.lastError);
      if (entry.kind !== "mcp") {
        // A live worker can retain its old cwd after the directory is removed.
        // Confirm that paths still resolve there before reporting ready context.
        try { await interruptible(callTool(input.target, "ls", { path: "." }, signal), signal); }
        catch (error) {
          if (signal.aborted) throw error;
          throw new AccessError(503, "target_unavailable", error.message);
        }
      }
      return { target: target(input.target), context: latest.context ?? null, tools: environment.descriptors(input.target) };
    }
    await interruptible(environment.connect(input.target), signal);
    const descriptor = environment.descriptors(input.target).find((tool) => tool.name === input.tool);
    if (!descriptor) throw new AccessError(400, "unknown_tool", "Unknown tool on this target. Inspect the target's tool list.");
    const args = input.args ?? {};
    const validArgs = validator.getValidator(descriptor.inputSchema)(args);
    if (!validArgs.valid) throw new AccessError(400, "invalid_tool_arguments", validArgs.errorMessage);
    try {
      const result = await interruptible(callTool(input.target, input.tool, args, signal), signal);
      return { target: { ...entry, ...target(input.target) }, tool: input.tool, result };
    } catch (error) {
      throw new AccessError(signal.aborted ? 504 : 502, signal.aborted ? "call_interrupted" : "tool_failed", error.message, "may_have_executed");
    }
  }

  function createMcpSession() {
    if (sessions.size >= 32) throw new AccessError(429, "too_many_clients", "Too many active MCP clients. Close an unused client or use HTTP.");
    const requests = new Map();
    const server = new Server({ name: "shared-agent-environment", version: "1.0.0" }, {
      capabilities: { tools: {} }, instructions: info.instructions.join("\n"),
    });
    const session = { server, requests, lastUsed: Date.now() };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID, enableJsonResponse: true,
      enableDnsRebindingProtection: true, allowedHosts, allowedOrigins: [publicOrigin],
      onsessioninitialized: (id) => sessions.set(id, session),
    });
    session.transport = transport;
    transport.onclose = () => { sessions.delete(transport.sessionId); };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: "environment", description: "Inspect the shared environment, get target project context, register an existing workspace, or explicitly call a native target tool. Every call specifies its target.", inputSchema,
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name !== "environment") return { isError: true, content: [{ type: "text", text: "Unknown tool. Use environment." }] };
      const admission = requests.get(extra.requestId);
      const signal = admission ? AbortSignal.any([extra.signal, admission.signal]) : extra.signal;
      try {
        const result = await execute(request.params.arguments ?? {}, signal);
        return result.result ? { content: result.result.content, structuredContent: { target: result.target, tool: result.tool,
          ...(result.result.structuredContent ? { result: result.result.structuredContent } : {}) },
          ...(result.result._meta ? { _meta: result.result._meta } : {}) } :
          { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = failure(error);
        return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } finally {
        // MCP cancellation does not require a response. Release the original
        // HTTP request as well as its tool rather than leaving it awaiting one.
        if (extra.signal.aborted) admission?.response.destroy();
      }
    });
    return session;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
    const controller = new AbortController();
    const disconnected = () => { if (!response.writableEnded) controller.abort(new AccessError(499, "cancelled", "Request disconnected")); };
    request.on("error", disconnected);
    request.on("aborted", disconnected); response.on("close", disconnected);
    const timer = setTimeout(() => {
      controller.abort(new AccessError(504, "timeout", "Environment request timed out"));
      setImmediate(() => { if (!response.writableEnded) response.destroy(); });
    }, requestTimeoutMs);
    timer.unref();
    active.add(controller);
    let session, rpcId;
    const cleanup = () => {
      clearTimeout(timer); active.delete(controller);
      request.off("aborted", disconnected); response.off("close", disconnected);
      if (rpcId !== undefined) session?.requests.delete(rpcId);
    };
    response.once("finish", cleanup); response.once("close", cleanup);
    try {
      if (!allowedHosts.includes(request.headers.host)) throw new AccessError(421, "invalid_host", "Unexpected Host header");
      if (request.headers.origin && request.headers.origin !== publicOrigin) throw new AccessError(403, "invalid_origin", "Unexpected Origin header");
      const path = new URL(request.url, initial.url).pathname;
      if ((path === "/" || path === "/connect.json") && ["GET", "HEAD"].includes(request.method)) {
        return request.method === "HEAD" ? response.writeHead(200, { "Content-Type": "application/json" }).end() : send(response, 200, info);
      }
      if (!["/api/environment", "/mcp"].includes(path)) throw new AccessError(404, "not_found", "Read / for environment connection instructions");
      // Read on each admission so replacing credentials or disabling access also
      // revokes existing MCP sessions without restarting the shared agent.
      let credentials;
      try { credentials = configuration(configFile); }
      catch { throw new AccessError(503, "access_unavailable", "Environment access configuration is unavailable"); }
      if (credentials.url !== initial.url || credentials.port !== initial.port) throw new AccessError(503, "access_unavailable", "The environment entry configuration changed; restart its listener");
      if (!authenticate(request.headers.authorization, credentials)) {
        request.resume();
        return send(response, 401, { error: { code: "unauthorized", message: "Provide the account and key using HTTP Basic authentication", execution: "not_started" } }, { "WWW-Authenticate": 'Basic realm="agent-environment", charset="UTF-8"' });
      }
      if (path === "/api/environment") {
        if (request.method !== "POST") throw new AccessError(405, "method", "Use POST application/json");
        return send(response, 200, await execute(await body(request), controller.signal));
      }
      const payload = request.method === "POST" ? await body(request) : undefined;
      const id = request.headers["mcp-session-id"];
      if (id) {
        session = sessions.get(id);
        if (!session) throw new AccessError(404, "mcp_session_expired", "MCP session expired. Initialize a new connection.");
      } else if (request.method === "POST" && isInitializeRequest(payload)) {
        session = createMcpSession();
        await session.server.connect(session.transport);
      } else throw new AccessError(400, "mcp_initialize", "Initialize MCP before using this endpoint");
      session.lastUsed = Date.now();
      if (payload?.id !== undefined && session.requests.has(payload.id)) throw new AccessError(409, "duplicate_request", "This MCP request ID is already running");
      rpcId = payload?.id;
      if (rpcId !== undefined) session.requests.set(rpcId, { signal: controller.signal, response });
      await session.transport.handleRequest(request, response, payload);
      if (!session.transport.sessionId) await session.server.close();
    } catch (error) {
      request.resume();
      if (!response.headersSent) send(response, error instanceof AccessError ? error.status : 503, failure(error));
      else response.destroy();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  const expiry = setInterval(() => {
    for (const session of sessions.values()) {
      if (!session.requests.size && Date.now() - session.lastUsed > sessionIdleMs) void session.server.close();
    }
  }, 60000);
  expiry.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(initial.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { clearInterval(expiry); throw error; }
  return {
    close: async () => {
      clearInterval(expiry);
      for (const controller of active) controller.abort(new AccessError(503, "shutdown", "Environment access is restarting"));
      await Promise.allSettled([...sessions.values()].map((session) => session.server.close()));
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

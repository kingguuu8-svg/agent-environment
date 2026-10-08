/** Isolated native SDK service with controlled initialization/discovery failures. */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function descriptors() {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  return ["probe_", "second_"].map((prefix) => ({
    name: prefix + suffix, description: "Echo a diagnostic message with a success marker.",
    inputSchema: { type: "object", properties: { message: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 15000 } }, required: ["message"], additionalProperties: false },
  }));
}

export async function createMcpService(mode = "ready") {
  const sessions = new Map(), sockets = new Set(), requests = [], calls = [];
  let tools = descriptors();
  const http = createServer(async (request, response) => {
    try {
      if (mode === "unauthorized") { response.writeHead(403); response.end("Fixture access denied"); return; }
      let body;
      if (request.method === "POST") {
        const pieces = [];
        for await (const piece of request) pieces.push(piece);
        body = JSON.parse(Buffer.concat(pieces).toString());
        requests.push({ method: body.method, cursor: body.params?.cursor });
        if (mode === "initialize" && body.method === "initialize"
          || mode === "initialized" && body.method === "notifications/initialized"
          || mode === "list" && body.method === "tools/list"
          || mode === "second-page" && body.method === "tools/list" && body.params?.cursor) return;
      }
      let session = sessions.get(request.headers["mcp-session-id"]);
      if (!session && body?.method === "initialize") {
        const server = new Server({ name: "discovery-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async (input) => ({
          tools: [tools[input.params?.cursor ? 1 : 0]], ...(input.params?.cursor ? {} : { nextCursor: "second-page" }),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (input) => {
          calls.push(input.params);
          if (!tools.some((tool) => tool.name === input.params.name)) return { isError: true, content: [{ type: "text", text: "Unknown diagnostic tool" }] };
          await delay(input.params.arguments.waitMs ?? 0);
          return { content: [{ type: "text", text: "SERVICE-OK:" + input.params.arguments.message }], structuredContent: { accepted: true, message: input.params.arguments.message } };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: (id) => sessions.set(id, { server, transport }) });
        session = { server, transport };
        await server.connect(transport);
      }
      if (!session) { response.writeHead(404); response.end(); return; }
      await session.transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(error.message);
    }
  });
  http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return {
    url: `http://127.0.0.1:${http.address().port}/mcp`, requests, calls,
    get tools() { return tools; }, setMode(value) { mode = value; }, replaceTools() { tools = descriptors(); },
    async close() {
      await Promise.allSettled([...sessions.values()].map((session) => session.server.close()));
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

// Python Host verification drives the same SDK fixtures through stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const services = { ready_service: await createMcpService(), stalled_service: await createMcpService("initialized") };
  try {
    await writeFile(process.argv[2], JSON.stringify({ targets: {}, mcp: Object.fromEntries(Object.entries(services).map(([id, service]) => [id, { url: service.url }])) }), { mode: 0o600 });
    console.log(JSON.stringify({ ready: true }));
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      const command = JSON.parse(line);
      if (command.action === "quit") break;
      if (command.action === "recover") { services.stalled_service.setMode("ready"); services.stalled_service.replaceTools(); }
      if (command.action === "stall") services.stalled_service.setMode("initialized");
      console.log(JSON.stringify({ requests: Object.fromEntries(Object.entries(services).map(([id, service]) => [id, service.requests])), calls: Object.fromEntries(Object.entries(services).map(([id, service]) => [id, service.calls])) }));
    }
    lines.close();
  } finally { await Promise.allSettled(Object.values(services).map((service) => service.close())); }
}

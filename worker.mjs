/** Adapt Pi's tool definitions to MCP; execution stays in Pi's implementation. */
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
  loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Value } from "typebox/value";
import { readWorkspaceFile } from "./workspace-files.mjs";

const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: process.cwd() },
    manifest: { type: "boolean", default: false },
    "check-manifest": { type: "boolean", default: false },
  },
});
const workspace = resolve(values.workspace);
const piPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8"),
);
const provider = { name: piPackage.name, version: piPackage.version };
const contextUri = "workspace://context";
const execFileAsync = promisify(execFile);

async function workspaceContext(signal) {
  const gitCommand = async (...args) => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: workspace, signal, timeout: 5000, maxBuffer: 1024 * 1024,
      });
      return stdout.trimEnd();
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
  };
  const root = await gitCommand("rev-parse", "--show-toplevel");
  const git = root === null ? null : {
    root,
    branch: await gitCommand("branch", "--show-current"),
    status: await gitCommand("status", "--short"),
  };
  return {
    hostname: hostname(), workspace, provider, git,
    agents_files: loadProjectContextFiles({ cwd: workspace, agentDir: getAgentDir() }),
  };
}
const definitions = [
  createReadToolDefinition(workspace),
  createWriteToolDefinition(workspace),
  createEditToolDefinition(workspace),
  // This worker has no Pi model or agent session to expose to subprocesses.
  createBashToolDefinition(workspace, { exposeSessionEnvironment: false }),
  createGrepToolDefinition(workspace),
  createFindToolDefinition(workspace),
  createLsToolDefinition(workspace),
  {
    name: "machine_info",
    description: "Identify the SSH machine, worker process, workspace and Pi tool provider.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const info = {
        hostname: hostname(),
        pid: process.pid,
        user_id: process.getuid?.(),
        workspace,
        node: process.version,
        provider,
      };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  },
];

function descriptor(tool) {
  const description = [tool.description, ...(tool.promptGuidelines ?? [])].join("\n");
  return {
    name: tool.name,
    description,
    inputSchema: tool.parameters,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    _meta: {
      "remote-mcp-demo/provider": tool.name === "machine_info" ? "diagnostic" : provider,
      ...(tool.promptSnippet ? { "pi/promptSnippet": tool.promptSnippet } : {}),
    },
  };
}

const manifest = { provider, tools: definitions.map(descriptor) };
if (values.manifest) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} else if (values["check-manifest"]) {
  const expected = JSON.parse(readFileSync(new URL("./pi-tools.json", import.meta.url), "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(manifest)) {
    throw new Error("Pi tool definitions differ from pi-tools.json; regenerate the manifest.");
  }
} else {
  const tools = new Map(definitions.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: "remote-pi-tools", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: manifest.tools }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
      uri: contextUri,
      name: "Remote workspace context",
      description: "Workspace identity, Git state and project instructions loaded by Pi.",
      mimeType: "application/json",
    }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const uri = request.params.uri;
    if (uri.startsWith("workspace://files?")) {
      const query = JSON.parse(new URL(uri).searchParams.get("request"));
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(await readWorkspaceFile(workspace, query, extra.signal)) }] };
    }
    if (uri !== contextUri) throw new Error(`Unknown resource: ${uri}`);
    return { contents: [{
      uri: contextUri, mimeType: "application/json",
      text: JSON.stringify(await workspaceContext(extra.signal)),
    }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const tool = tools.get(request.params.name);
      if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
      const input = structuredClone(request.params.arguments ?? {});
      const args = tool.prepareArguments ? await tool.prepareArguments(input) : input;
      if (!Value.Check(tool.parameters, args)) {
        throw new Error(`Invalid arguments for ${tool.name}: ${JSON.stringify([...Value.Errors(tool.parameters, args)])}`);
      }
      let progress = 0;
      const token = request.params._meta?.progressToken;
      const onUpdate = token === undefined ? undefined : (update) => {
        const message = update.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        void extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: ++progress, message },
        }).catch((error) => console.error("Progress delivery failed:", error.message));
      };
      const result = await tool.execute(String(extra.requestId), args, extra.signal, onUpdate);
      return {
        content: result.content,
        ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
        ...(result.details ? { _meta: { "pi/details": result.details } } : {}),
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  const close = () => {
    // The SDK stdio transport does not observe EOF. Closing the server aborts
    // every active handler, so Pi can stop its subprocesses before we exit.
    void server.close().catch((error) => console.error("Worker close failed:", error.message));
  };
  process.stdin.once("end", close);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, close);
  await server.connect(new StdioServerTransport());
}

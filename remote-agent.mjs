/** A Pi session whose tools and project context belong to one remote workspace. */
import {
  createAgentSession,
  createEditToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = dirname(fileURLToPath(import.meta.url));
export const toolNames = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const bindingType = "remote-workspace";
const contextUri = "workspace://context";

function sameBinding(left, right) {
  return ["machine", "host", "port", "workspace", "uri"].every((key) => left?.[key] === right[key]);
}

export function remotePath(binding, path) {
  const authority = binding.uri.slice(0, binding.uri.indexOf("/", binding.uri.indexOf("://") + 3));
  return authority + path.split("/").map(encodeURIComponent).join("/");
}

export async function openWorkspace(options) {
  const client = new Client({ name: "remote-pi-session", version: "0.1.0" });
  let transport;
  if (options.localWorkspace) {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "worker.mjs"), "--workspace", options.localWorkspace],
      stderr: "inherit",
    });
  } else if (options.url) {
    transport = new StreamableHTTPClientTransport(new URL(options.url));
  } else {
    if (!options.config || !options.machine) throw new Error("Provide --config and --machine, or --url");
    const args = [join(root, "workspace_gateway.py"), "--config", resolve(options.config), "--machine", options.machine];
    if (options.workspace !== undefined) args.push("--workspace", options.workspace);
    transport = new StdioClientTransport({
      command: options.python ?? (existsSync(join(root, ".venv/bin/python")) ? join(root, ".venv/bin/python") : "python3"),
      args,
      env: {
        ...getDefaultEnvironment(),
        ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
      },
      stderr: "inherit",
    });
  }
  try {
    await client.connect(transport);
    const descriptors = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 300000 });
      descriptors.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    for (const name of toolNames) {
      if (!descriptors.some((tool) => tool.name === name)) throw new Error(`Remote workspace is missing ${name}`);
    }
    const fetchContext = async (signal) => {
      const result = await client.readResource({ uri: contextUri }, { timeout: 30000, signal });
      const context = JSON.parse(result.contents[0].text);
      if (options.localWorkspace) context.binding = {
        machine: "cloud", host: context.hostname, port: null, workspace: context.workspace,
        uri: `local://${context.hostname}${context.workspace.split("/").map(encodeURIComponent).join("/")}`,
      };
      return context;
    };
    const context = await fetchContext();
    return { client, descriptors, context, fetchContext, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function createRemoteSession(options) {
  const remote = await openWorkspace(options);
  let session;
  try {
    let context = remote.context;
    const binding = context.binding;
    const stateDir = resolve(options.stateDir ?? join(homedir(), ".local/share/remote-mcp-demo/agent"));
    const workspaceId = createHash("sha256").update(binding.uri).digest("hex").slice(0, 24);
    const sessionDir = join(stateDir, "sessions", workspaceId);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    let sessionManager;
    if (options.sessionFile) {
      const file = resolve(options.sessionFile);
      if (!existsSync(file)) throw new Error(`Session file does not exist: ${file}`);
      sessionManager = SessionManager.open(file, sessionDir);
      const bindings = sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === bindingType);
      if (bindings.length === 0 || bindings.some((entry) => !sameBinding(entry.data, binding))) {
        throw new Error("Session belongs to a different remote workspace; start a new session for this target");
      }
    } else {
      sessionManager = SessionManager.create(binding.workspace, sessionDir);
      sessionManager.appendCustomEntry(bindingType, binding);
    }
    // Pi validates model calls before dispatching them to MCP. Reuse its edit
    // preparer here too, so model-produced JSON strings retain native behavior.
    const prepareEditArguments = createEditToolDefinition(binding.workspace).prepareArguments;
    const customTools = remote.descriptors.filter((tool) => toolNames.includes(tool.name)).map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      promptSnippet: tool._meta?.["pi/promptSnippet"],
      parameters: tool.inputSchema,
      ...(tool.name === "edit" ? { prepareArguments: prepareEditArguments } : {}),
      async execute(id, args, signal, onUpdate) {
        const result = await remote.client.callTool({ name: tool.name, arguments: args }, undefined, {
          signal,
          timeout: 150000,
          ...(onUpdate ? { onprogress: (progress) => onUpdate({
            content: [{ type: "text", text: progress.message ?? "" }],
            details: { remote: binding },
          }) } : {}),
        });
        if (result.isError) {
          throw new Error(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"));
        }
        return {
          content: result.content,
          details: {
            ...result._meta?.["pi/details"],
            remote: binding,
            ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
          },
        };
      },
    }));
    const applyContext = (promptOptions) => {
      promptOptions.cwd = binding.uri;
      promptOptions.sections.docs = `Pi tool provider: ${context.provider.name}@${context.provider.version}`;
      promptOptions.appendSystemPrompt = "";
      promptOptions.contextFiles = context.agents_files.map((file) => ({
        path: remotePath(binding, file.path), content: file.content,
      }));
      promptOptions.sections.remote_workspace = [
        `Machine: ${binding.machine} (${context.hostname})`,
        `Workspace directory: ${binding.workspace}`,
        `File reference prefix: ${binding.uri}`,
        "All file tools and shell commands execute on this remote machine. Relative paths start in this workspace.",
        "Use the remote reference prefix when identifying files to the user.",
        `Git: ${JSON.stringify(context.git)}`,
      ].join("\n");
    };
    const agentDir = resolve(options.agentDir ?? getAgentDir());
    const settingsManager = SettingsManager.inMemory();
    class RemoteResourceLoader extends DefaultResourceLoader {
      getAgentsFiles() {
        return { agentsFiles: context.agents_files.map((file) => ({
          path: remotePath(binding, file.path), content: file.content,
        })) };
      }
      getAppendSystemPrompt() { return [`Remote workspace: ${binding.uri}`]; }
    }
    const resourceLoader = new RemoteResourceLoader({
      cwd: binding.workspace, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on("before_agent_start", (event) => applyContext(event.systemPromptOptions));
      }],
    });
    await resourceLoader.reload();
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    });
    let model;
    if (options.model) {
      const separator = options.model.indexOf("/");
      model = modelRuntime.getModel(options.model.slice(0, separator), options.model.slice(separator + 1));
      if (separator < 1 || !model) throw new Error(`Unknown model: ${options.model}`);
    }
    ({ session } = await createAgentSession({
      cwd: binding.workspace, agentDir, resourceLoader, sessionManager, settingsManager,
      modelRuntime, model, tools: toolNames, customTools,
    }));
    await session.bindExtensions({ mode: "print" });
    return {
      session, binding,
      get context() { return context; },
      async prompt(text, { signal } = {}) {
        // Pi reports hook failures and continues. Check connectivity outside a
        // hook so an unavailable workspace prevents the model turn entirely.
        const refreshed = await remote.fetchContext(signal);
        signal?.throwIfAborted();
        if (!sameBinding(refreshed.binding, binding)) throw new Error("Remote workspace binding changed");
        context = refreshed;
        session.setActiveToolsByName(toolNames);
        await session.prompt(text);
      },
      async close() {
        await session.abort();
        session.dispose();
        await remote.close();
      },
    };
  } catch (error) {
    session?.dispose();
    await remote.close();
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: "string" }, machine: { type: "string" }, workspace: { type: "string" },
    url: { type: "string" }, python: { type: "string" }, model: { type: "string" },
    "agent-dir": { type: "string" }, "state-dir": { type: "string" }, session: { type: "string" },
    prompt: { type: "string" }, json: { type: "boolean" }, inspect: { type: "boolean" },
  } });
  if (values.url && (values.config || values.machine || values.workspace)) throw new Error("Use --url or --config/--machine/--workspace");
  if (values.json && !values.prompt && !values.inspect) throw new Error("--json requires --prompt or --inspect");
  const remote = await createRemoteSession({
    ...values, agentDir: values["agent-dir"], stateDir: values["state-dir"], sessionFile: values.session,
  });
  const { session, binding } = remote;
  const calls = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end") calls.push({ name: event.toolName, is_error: event.isError });
    if (!values.json && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  const controller = new AbortController();
  let input;
  const abort = () => {
    controller.abort();
    input?.close();
    void session.abort();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    if (values.inspect) {
      console.log(JSON.stringify({
        binding, context: remote.context, tools: session.getActiveToolNames(),
        session_file: session.sessionManager.getSessionFile(),
      }, null, 2));
      return;
    }
    if (!session.model) throw new Error("Configure a model in Pi's agent directory before sending a prompt");
    console.error(`Workspace: ${binding.uri}\nSession: ${session.sessionManager.getSessionFile()}`);
    const prompt = async (text) => {
      const start = calls.length;
      await remote.prompt(text, { signal: controller.signal });
      const last = session.state.messages.findLast((message) => message.role === "assistant");
      const error = last?.stopReason === "error" || last?.stopReason === "aborted" ? last.errorMessage ?? last.stopReason : undefined;
      if (values.json) console.log(JSON.stringify({
        binding, session_file: session.sessionManager.getSessionFile(),
        tool_calls: calls.slice(start),
        assistant: last?.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"),
        ...(error ? { error } : {}),
      }));
      else process.stdout.write("\n");
      if (error) throw new Error(error);
    };
    if (values.prompt) await prompt(values.prompt);
    else {
      input = createInterface({ input: process.stdin, output: process.stdout });
      input.setPrompt(`${binding.machine}:${binding.workspace}> `);
      input.prompt();
      for await (const text of input) {
        if (text.trim() === "/exit") break;
        if (text.trim()) await prompt(text);
        input.prompt();
      }
    }
  } finally {
    input?.close();
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    await remote.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

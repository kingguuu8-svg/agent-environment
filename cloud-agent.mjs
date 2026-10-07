/** Pi owns the model loop, compaction and JSONL history; the service owns its lifetime. */
import {
  createAgentSession, createEditToolDefinition, DefaultResourceLoader,
  getAgentDir, ModelRuntime, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { remotePath } from "./remote-agent.mjs";

export async function createCloudAgent({ environment, manager, agentDir, modelRuntime, model, onEvent }) {
  const agent = { focus: null, context: null, liveMessage: null, liveTools: new Map(), version: environment.version };
  const settingsManager = SettingsManager.inMemory();
  agentDir = resolve(agentDir ?? getAgentDir());
  modelRuntime ??= await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const customTools = [];
  // Same-name Pi tools retain the local experience. Explicit target tools stay
  // bound to their workspace even when a terminal changes the session's focus.
  for (const descriptor of environment.manifest) customTools.push({
    name: descriptor.name, label: descriptor.name,
    description: `${descriptor.description}\nExecutes in the current workspace shown in the system context.`,
    parameters: descriptor.inputSchema,
    promptSnippet: descriptor._meta?.["pi/promptSnippet"],
    ...(descriptor.name === "edit" ? { prepareArguments: createEditToolDefinition(process.cwd()).prepareArguments } : {}),
    execute: (...args) => environment.definition(agent.focus, descriptor, descriptor.name).execute(...args),
  });
  for (const id of environment.entries.keys()) {
    for (const descriptor of environment.descriptors(id)) customTools.push(environment.definition(id, descriptor));
  }
  customTools.push({
    name: "environment", label: "Environment",
    description: "List available machines, workspaces and MCP services, including connection state and target-specific instructions.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: JSON.stringify({
        current_workspace: agent.focus,
        resources: environment.list().map((entry) => ({
          ...entry, instructions: environment.get(entry.id).context?.agents_files ?? [],
          tools: environment.descriptors(entry.id).map((tool) => `${entry.id}__${tool.name}`),
        })),
      }) }], details: {} };
    },
  });
  const applyContext = (options) => {
    const context = agent.context;
    const entry = environment.get(agent.focus);
    const binding = context?.binding;
    options.cwd = binding?.uri ?? `${entry.machine}:${entry.workspace}`;
    options.sections.docs = "Tools are supplied by Pi 1.0.2 and the registered MCP services.";
    options.appendSystemPrompt = "";
    options.contextFiles = (context?.agents_files ?? []).map((file) => ({
      path: remotePath(binding, file.path), content: file.content,
    }));
    options.sections.remote_workspace = [
      `Current workspace: ${agent.focus}`,
      `Machine: ${entry.machine}; directory: ${entry.workspace}; URI: ${binding?.uri ?? "unavailable"}`,
      `Availability: ${entry.lastError ? `unavailable (${entry.lastError})` : "connected"}`,
      "The ordinary read/write/edit/bash/grep/find/ls tools use this workspace for this entire turn.",
      "Use <workspace>__<tool> to operate another registered workspace or MCP service.",
      "Retain the machine-qualified URI in file references. Historical paths keep their original machine identity.",
      "A new terminal connection does not change the workspace. Workspace changes are recorded explicitly.",
      "If a target is unavailable, conversation history and other targets remain usable. Never infer a tool succeeded from a lost connection.",
      `Git: ${JSON.stringify(context?.git ?? null)}`,
    ].join("\n");
    options.sections.environment = "Environment resources (apply project instructions only to their own workspace):\n" +
      JSON.stringify(environment.list().map((item) => ({
        ...item,
        ...(item.id !== agent.focus ? { instructions: environment.get(item.id).context?.agents_files ?? [] } : {}),
      })));
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: environment.get("cloud").workspace, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => { pi.on("before_agent_start", (event) => applyContext(event.systemPromptOptions)); }],
  });
  await resourceLoader.reload();
  let selected;
  if (model) {
    const separator = model.indexOf("/");
    selected = modelRuntime.getModel(model.slice(0, separator), model.slice(separator + 1));
    if (separator < 1 || !selected) throw new Error(`Unknown model: ${model}`);
  }
  const { session } = await createAgentSession({
    cwd: environment.get("cloud").workspace, agentDir, resourceLoader, sessionManager: manager,
    settingsManager, modelRuntime, model: selected, tools: customTools.map((tool) => tool.name), customTools,
  });
  await session.bindExtensions({ mode: "print" });
  session.setActiveToolsByName(customTools.map((tool) => tool.name));
  const active = new Set(session.getActiveToolNames());
  for (const tool of customTools) if (!active.has(tool.name)) throw new Error(`Environment tool was not declared to the model: ${tool.name}`);
  const publish = (event) => {
    if (event.type === "message_update") agent.liveMessage = event.message;
    if (event.type === "message_end") agent.liveMessage = null;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") agent.liveTools.set(event.toolCallId, event);
    if (event.type === "tool_execution_end") agent.liveTools.delete(event.toolCallId);
    onEvent(event);
  };
  const unsubscribe = session.subscribe(publish);
  agent.session = session;
  agent.tools = new Map(customTools.map((tool) => [tool.name, tool]));
  agent.prepare = async (focus, signal) => {
    agent.focus = focus;
    agent.context = await environment.refresh(focus, signal);
    signal?.throwIfAborted();
  };
  agent.prompt = async (text, images, signal) => {
    if (!session.model) throw new Error("Configure a model on the cloud server before sending a prompt");
    const abort = () => { void session.abort(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await session.prompt(text, { images });
      const last = session.messages.findLast((message) => message.role === "assistant");
      if (last?.stopReason === "error" || last?.stopReason === "aborted") throw new Error(last.errorMessage ?? last.stopReason);
      return { assistant: last?.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") };
    } finally { signal.removeEventListener("abort", abort); }
  };
  agent.execute = async (name, args, signal) => {
    const tool = agent.tools.get(name);
    if (!tool) throw new Error(`Unknown environment tool: ${name}`);
    const callId = "terminal-" + randomUUID();
    publish({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
    let result;
    try {
      const prepared = tool.prepareArguments ? await tool.prepareArguments(structuredClone(args)) : args;
      if (!Value.Check(tool.parameters, prepared)) throw new Error(`Invalid arguments for ${name}`);
      result = await tool.execute(callId, prepared, signal, (partialResult) => publish({
        type: "tool_execution_update", toolCallId: callId, toolName: name, args, partialResult,
      }));
      const target = result.details?.remote?.uri ?? result.details?.workspace ?? agent.focus;
      await session.sendCustomMessage({
        customType: "environment-tool", display: true,
        content: `Terminal tool ${name} at ${target}:\nArguments: ${JSON.stringify(args)}\n` +
          result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"),
        details: { tool: name, focus: agent.focus, ...result.details },
      }, { triggerTurn: false });
      return result;
    } finally {
      publish({ type: "tool_execution_end", toolCallId: callId, toolName: name, result: result ?? {
        content: [{ type: "text", text: signal.aborted ? "Cancelled" : "Tool failed" }],
      }, isError: !result });
    }
  };
  agent.close = async () => { await session.abort(); unsubscribe(); session.dispose(); };
  return agent;
}

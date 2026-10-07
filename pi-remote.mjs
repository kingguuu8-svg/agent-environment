#!/usr/bin/env node
/** A remote terminal assembled from Pi's editor, message/tool renderers and resume selector. */
import {
  AssistantMessageComponent, createBashToolDefinition, createEditToolDefinition,
  createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  createReadToolDefinition, createWriteToolDefinition, getSelectListTheme,
  initTheme, SessionSelectorComponent, ToolExecutionComponent, UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider, Container, Editor, matchesKey, ProcessTerminal,
  SelectList, Text, TuiMainScreen,
} from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CloudClient } from "./cloud-client.mjs";
import { readJson } from "./environment.mjs";

const help = "/resume [all|session-id] [--current] · /workspace [current|id] · /environment · /takeover · /fork [entry-id] [--current] · /cancel · /new · /model provider/model · /exit\n!command runs in the current workspace; !@cloud command runs on the cloud server. /tool name JSON calls any registered tool.";
const textContent = (content) => typeof content === "string" ? content : content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";

export class RemoteTerminal {
  constructor(client, options = {}) {
    this.client = client;
    this.options = options;
    this.toolComponents = new Map();
    this.assistant = null;
    this.closed = new Promise((resolve) => { this.finish = resolve; });
  }
  status() {
    const state = this.client.state;
    const workspace = state?.workspace;
    return `Cloud session ${state?.id ?? "—"}\n${workspace?.machine ?? ""}:${workspace?.workspace ?? ""} · ${state?.status ?? "disconnected"} · ${state?.canInput ? "input control" : `viewing; controller: ${state?.controller?.name ?? "none"}`}${state?.pendingFocus ? ` · next workspace: ${state.pendingFocus}` : ""}`;
  }
  notice(text) {
    if (this.ui) { this.chat.addChild(new Text(text, 1, 1)); this.ui.requestRender(); }
    else console.error(text);
  }
  updateStatus() {
    if (this.footer) { this.footer.setText(this.status()); this.ui.requestRender(); }
  }
  executionWorkspace(name) {
    return name.includes("__") ? this.client.state?.environment.find((item) => item.id === name.split("__")[0]) : this.client.state?.workspace;
  }
  renderer(name, workspace) {
    if (name.includes("__") && (!this.executionWorkspace(name) || this.executionWorkspace(name).kind === "mcp")) return undefined;
    const factories = {
      read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition,
      bash: createBashToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition,
    };
    return factories[name.split("__").at(-1)]?.(workspace?.workspace ?? process.cwd());
  }
  tool(event) {
    let component = this.toolComponents.get(event.toolCallId);
    if (!component) {
      const workspace = this.historyTargets?.get(event.toolCallId) ?? this.executionWorkspace(event.toolName);
      component = new ToolExecutionComponent(event.toolName, event.toolCallId, event.args ?? {}, undefined,
        this.renderer(event.toolName, workspace), this.ui, workspace?.workspace ?? process.cwd());
      this.toolComponents.set(event.toolCallId, component);
      this.chat.addChild(component);
    }
    return component;
  }
  renderMessage(message) {
    if (message.role === "user") this.chat.addChild(new UserMessageComponent(textContent(message.content)));
    else if (message.role === "assistant") {
      this.assistant = new AssistantMessageComponent(message);
      this.chat.addChild(this.assistant);
      for (const block of message.content) if (block.type === "toolCall") this.tool({ toolCallId: block.id, toolName: block.name, args: block.arguments }).setArgsComplete();
    } else if (message.role === "toolResult") {
      this.tool({ toolCallId: message.toolCallId, toolName: message.toolName }).updateResult(message);
    } else if (message.role === "custom" && message.display) this.chat.addChild(new Text(textContent(message.content), 1, 1));
  }
  renderSnapshot() {
    if (!this.ui) { this.notice(this.status()); return; }
    this.chat.clear();
    this.toolComponents.clear();
    this.assistant = null;
    const state = this.client.state;
    this.historyTargets = new Map(state.messages.filter((message) => message.role === "toolResult" && message.details?.remote)
      .map((message) => [message.toolCallId, message.details.remote]));
    for (const message of state.messages) this.renderMessage(message);
    if (state.activeMessage && !state.messages.some((message) => message.role === "assistant" && message.timestamp === state.activeMessage.timestamp)) {
      this.renderMessage(state.activeMessage);
      this.assistant?.updateContent(state.activeMessage, true);
    }
    for (const event of state.activeTools) {
      const component = this.tool(event);
      component.markExecutionStarted();
      if (event.partialResult) component.updateResult({ ...event.partialResult, isError: false }, true);
    }
    this.updateStatus();
    this.ui.requestRender();
  }
  event(message) {
    if (message.session !== this.client.state?.id) return;
    const event = message.event;
    if (!this.ui) {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") process.stdout.write(event.assistantMessageEvent.delta);
      if (event.type === "turn_complete") {
        if (event.error) this.notice(event.error);
        else if (event.result?.content) console.log(textContent(event.result.content));
        else process.stdout.write("\n");
      }
      if (event.type === "session_state") this.notice(this.status());
      return;
    }
    if (event.type === "message_start") {
      if (event.message.role !== "toolResult") this.renderMessage(event.message);
    } else if (event.type === "message_update") this.assistant?.updateContent(event.message, true);
    else if (event.type === "message_end" && event.message.role === "assistant") this.assistant?.updateContent(event.message, false);
    else if (event.type === "tool_execution_start") this.tool(event).markExecutionStarted();
    else if (event.type === "tool_execution_update") this.tool(event).updateResult({ ...event.partialResult, isError: false }, true);
    else if (event.type === "tool_execution_end") this.tool(event).updateResult({ ...event.result, isError: event.isError });
    else if (event.type === "turn_complete" && event.error) this.notice(event.error);
    else if (event.type === "session_state") this.updateStatus();
    this.ui.requestRender();
  }
  async resume(all = false, useCurrentWorkspace = false) {
    if (!this.ui) {
      const sessions = await this.client.request("list", { all });
      for (const item of sessions) console.log(`${item.id}  ${item.title}  ${item.workspace?.uri ?? item.focus}  ${item.status}`);
      return;
    }
    const loader = (all) => async () => (await this.client.request("list", { all })).map((item) => ({
      path: `cloud-session:${item.id}`, id: item.id,
      name: `${item.title} · ${item.status}${item.controller ? ` · ${item.controller.name}` : ""}`,
      cwd: item.workspace?.uri ?? item.focus,
      created: new Date(item.created), modified: new Date(item.modified),
      messageCount: 0, firstMessage: item.title, allMessagesText: item.title,
      parentSessionPath: item.parentId ? `cloud-session:${item.parentId}` : undefined,
    }));
    let overlay;
    const close = () => { overlay?.hide(); this.selectorActive = false; this.ui.setFocus(this.editor); };
    const selector = new SessionSelectorComponent(loader(false), loader(true), (path) => {
      close();
      void this.client.request("attach", { session: path.slice("cloud-session:".length), useCurrentWorkspace })
        .then(() => this.renderSnapshot()).catch((error) => this.notice(error.message));
    }, close, close, () => this.ui.requestRender(), { showRenameHint: false }, `cloud-session:${this.client.state.id}`);
    // The upstream selector's deletion hook targets local files. Cloud sessions
    // have a separate owner, so this frontend deliberately supplies its own hook.
    selector.getSessionList().onDeleteSession = async () => { throw new Error("Cloud session deletion is not available in this demo"); };
    overlay = this.ui.showOverlay(selector, { width: "95%", maxHeight: "90%" });
    this.selectorActive = true;
    if (all) selector.getSessionList().onToggleScope?.();
  }
  async chooseWorkspace() {
    const resources = (await this.client.request("environment")).filter((item) => item.kind !== "mcp");
    if (!this.ui) {
      this.notice(resources.map((item) => `${item.id}  ${item.machine}:${item.workspace}  ${item.availability}`).join("\n"));
      return;
    }
    const selector = new SelectList(resources.map((item) => ({
      value: item.id, label: `${item.machine}:${item.workspace}`,
      description: `${item.availability}${item.id === this.client.state.focus ? " · current" : ""}`,
    })), 12, getSelectListTheme());
    let overlay;
    const close = () => { overlay.hide(); this.selectorActive = false; this.ui.setFocus(this.editor); };
    selector.onCancel = close;
    selector.onSelect = (item) => {
      close();
      void this.client.mutate("workspace", { workspaceId: item.value }).then(() => this.renderSnapshot()).catch((error) => this.notice(error.message));
    };
    this.selectorActive = true;
    overlay = this.ui.showOverlay(selector, { width: "90%", maxHeight: "80%" });
  }
  async submit(text) {
    text = text.trim();
    if (!text) return;
    const [command, ...args] = text.split(/\s+/);
    const current = args.includes("--current");
    const positional = args.filter((arg) => arg !== "--current");
    switch (command) {
      case "/exit": case "/detach": this.stop(); return;
      case "/help": this.notice(help); return;
      case "/resume": {
        if (!positional[0] || positional[0] === "all") await this.resume(positional[0] === "all", current);
        else { await this.client.request("attach", { session: positional[0], useCurrentWorkspace: current }); this.renderSnapshot(); }
        return;
      }
      case "/new": await this.client.request("attach", {}); this.renderSnapshot(); return;
      case "/takeover": await this.client.request("take_control"); this.updateStatus(); this.notice("Input control acquired."); return;
      case "/cancel": await this.client.mutate("cancel"); return;
      case "/workspace": {
        if (!positional[0]) { await this.chooseWorkspace(); return; }
        await this.client.mutate("workspace", { workspaceId: positional[0] }); this.renderSnapshot(); return;
      }
      case "/environment": case "/terminal": this.notice(JSON.stringify(await this.client.request("environment"), null, 2)); return;
      case "/fork": await this.client.mutate("fork", { entryId: positional[0], useCurrentWorkspace: current }); this.renderSnapshot(); return;
      case "/model": {
        if (!positional[0]) { this.notice(JSON.stringify(this.client.state.model)); return; }
        await this.client.mutate("set_model", { model: positional[0] }); this.updateStatus(); return;
      }
      case "/reconnect": {
        const session = this.client.state?.id;
        this.client.close(); await this.client.connect();
        await this.client.request("attach", { session, mode: "view" }); this.renderSnapshot();
        this.notice("Reconnected to cloud session. Use /takeover to regain input control."); return;
      }
      case "/tool": {
        const name = positional[0];
        const json = text.slice(text.indexOf(name) + name.length).trim();
        return this.client.mutate("tool", { name, args: JSON.parse(json || "{}"), turnId: randomUUID() });
      }
      default: {
        if (text.startsWith("!")) {
          const target = /^!@([a-z][a-z0-9_]*)\s+([\s\S]+)$/.exec(text);
          return this.client.mutate("tool", { name: target ? `${target[1]}__bash` : "bash", args: { command: target ? target[2] : text.slice(1) }, turnId: randomUUID() });
        }
        if (text.startsWith("/")) throw new Error(`Unknown command: ${command}. Use /help.`);
        return this.client.mutate("prompt", { text, turnId: randomUUID() });
      }
    }
  }
  async start() {
    this.onEvent = (message) => this.event(message);
    this.onDisconnect = (error) => { this.notice(`${error.message}. Tasks remain on the cloud server. /reconnect restores viewing; /takeover restores input.`); this.updateStatus(); };
    this.client.on("event", this.onEvent);
    this.client.on("disconnect", this.onDisconnect);
    if (process.stdin.isTTY && process.stdout.isTTY && !this.options.plain) {
      initTheme("dark", false);
      this.ui = new TuiMainScreen(new ProcessTerminal());
      this.chat = new Container();
      this.footer = new Text("", 1, 0);
      this.editor = new Editor(this.ui, { borderColor: (text) => text, selectList: getSelectListTheme() });
      const commands = new CombinedAutocompleteProvider([
        "resume", "workspace", "environment", "takeover", "fork", "cancel", "new", "model", "exit", "help", "reconnect", "tool",
      ].map((name) => ({ name, description: name })), process.cwd(), null);
      this.editor.setAutocompleteProvider({
        getSuggestions: (lines, line, column, options) => lines[line]?.startsWith("/")
          ? commands.getSuggestions(lines, line, column, options) : Promise.resolve(null),
        applyCompletion: (...args) => commands.applyCompletion(...args),
        shouldTriggerFileCompletion: () => false,
      });
      this.editor.onSubmit = (text) => {
        this.editor.addToHistory(text); this.editor.setText("");
        void this.submit(text).catch((error) => this.notice(error.message));
      };
      this.ui.addChild(this.chat); this.ui.addChild(this.footer); this.ui.addChild(this.editor);
      this.ui.addInputListener((data) => {
        if (this.selectorActive) return;
        if (matchesKey(data, "ctrl+d") && !this.editor.getText()) { this.stop(); return { consume: true }; }
        if (matchesKey(data, "escape") && !this.editor.isShowingAutocomplete()) {
          void this.client.mutate("cancel").catch((error) => this.notice(error.message)); return { consume: true };
        }
        if (matchesKey(data, "ctrl+c")) { this.editor.setText(""); return { consume: true }; }
      });
      this.ui.setFocus(this.editor); this.renderSnapshot(); this.ui.start();
      this.notice("Remote Pi · /resume all finds sessions from every machine · Ctrl+D detaches · Esc cancels");
    } else {
      this.renderSnapshot();
      this.lines = createInterface({ input: process.stdin, output: process.stdout });
      void (async () => {
        for await (const text of this.lines) {
          try { await this.submit(text); } catch (error) { this.notice(error.message); }
        }
        this.stop();
      })();
    }
    await this.closed;
  }
  stop() {
    this.client.off("event", this.onEvent); this.client.off("disconnect", this.onDisconnect);
    this.ui?.stop(); this.lines?.close(); this.client.close(); this.finish();
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    remote: { type: "boolean" }, config: { type: "string" }, socket: { type: "string" },
    machine: { type: "string" }, workspace: { type: "string" }, "workspace-id": { type: "string" },
    session: { type: "string" }, view: { type: "boolean" }, current: { type: "boolean" },
    prompt: { type: "string" }, json: { type: "boolean" }, list: { type: "boolean" },
    inspect: { type: "boolean" }, plain: { type: "boolean" },
  } });
  const config = readJson(resolve(values.config ?? join(homedir(), ".config/remote-pi/client.json")), {});
  const client = new CloudClient({
    ...config, socket: values.socket ?? config.socket, name: `${hostname()}:${process.pid}`,
    machine: values.machine ?? config.machine ?? (values.socket || config.socket ? "cloud" : undefined),
    workspace: values.workspace ?? process.cwd(), workspaceId: values["workspace-id"],
  });
  client.on("diagnostic", (message) => process.stderr.write(message));
  try {
    await client.connect();
    if (values.list) { console.log(JSON.stringify(await client.request("list", { all: true }), null, 2)); return; }
    await client.request("attach", { session: values.session, mode: values.view ? "view" : "control", useCurrentWorkspace: values.current });
    if (values.inspect) { console.log(JSON.stringify(client.state, null, 2)); return; }
    if (values.prompt) {
      const turnId = randomUUID();
      if (!values.json) client.on("event", (message) => {
        if (message.event.type === "message_update" && message.event.assistantMessageEvent?.type === "text_delta") process.stdout.write(message.event.assistantMessageEvent.delta);
      });
      await client.mutate("prompt", { text: values.prompt, turnId });
      const outcome = await client.waitTurn(turnId);
      if (values.json) console.log(JSON.stringify({ session: client.state.id, ...outcome }));
      else process.stdout.write("\n");
      if (outcome.status !== "completed") throw new Error(outcome.error ?? outcome.status);
      return;
    }
    const terminal = new RemoteTerminal(client, values);
    const stop = () => terminal.stop();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await terminal.start(); }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  } finally { client.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

/** Verify workspace semantics using real SSH, MCP and Pi session storage. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { createRemoteSession, openWorkspace, toolNames } from "./remote-agent.mjs";

const { values } = parseArgs({ options: {
  config: { type: "string" }, machine: { type: "string" }, python: { type: "string" },
  "workspace-a": { type: "string" }, "workspace-b": { type: "string" },
  "state-dir": { type: "string" }, "agent-dir": { type: "string" },
  model: { type: "string" }, output: { type: "string" },
  "require-different-host": { type: "boolean" },
} });
const base = {
  config: values.config, machine: values.machine, stateDir: values["state-dir"],
  agentDir: values["agent-dir"], model: values.model, python: values.python,
};
const aOptions = { ...base, workspace: values["workspace-a"] };
const bOptions = { ...base, workspace: values["workspace-b"] };
const sessions = [];
const checks = [];
let connection;
let agentTask;
const passed = (name) => { checks.push(name); console.error(`PASS ${name}`); };
const text = (result) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
const execute = (remote, name, args, signal, onUpdate) => {
  const tool = remote.session.agent.state.tools.find((item) => item.name === name);
  assert(tool, `Missing active tool: ${name}`);
  return tool.execute(`verify-${Date.now()}`, args, signal, onUpdate);
};

try {
  const created = await Promise.allSettled([aOptions, bOptions].map(async (options) => {
    const remote = await createRemoteSession(options);
    sessions.push(remote);
    return remote;
  }));
  for (const result of created) if (result.status === "rejected") throw result.reason;
  const [a, b] = created.map((result) => result.value);
  assert.notEqual(a.binding.uri, b.binding.uri);
  assert.equal(a.binding.host, b.binding.host);
  assert.equal(a.binding.workspace, resolve(values["workspace-a"]));
  assert.equal(b.binding.workspace, resolve(values["workspace-b"]));
  if (values["require-different-host"]) assert.notEqual(a.context.hostname, hostname());
  passed("two simultaneous workspace sessions share the SSH machine and install safely");

  for (const remote of [a, b]) {
    assert.deepEqual(new Set(remote.session.getActiveToolNames()), new Set(toolNames));
    assert(remote.session.systemPrompt.includes(remote.binding.uri));
    assert(remote.session.systemPrompt.includes("shared-context-token"));
    assert(!remote.session.systemPrompt.includes("local-context-token"));
    assert.equal(remote.context.git.root, remote.binding.workspace);
  }
  assert(a.session.systemPrompt.includes("alpha-marker-v1"));
  assert(b.session.systemPrompt.includes("beta-marker-v1"));
  assert.equal(a.context.git.branch, "alpha");
  assert.equal(b.context.git.branch, "beta");
  passed("native tool names, remote identity, ancestor instructions and Git context are loaded");

  await Promise.all([
    execute(a, "write", { path: "proof.txt", content: "alpha\n" }),
    execute(b, "write", { path: "proof.txt", content: "beta\n" }),
  ]);
  assert.equal(text(await execute(a, "read", { path: "proof.txt" })), "alpha\n");
  assert.equal(text(await execute(b, "read", { path: "proof.txt" })), "beta\n");
  assert(!existsSync("proof.txt"));
  const shell = await execute(a, "bash", { command: "pwd; hostname" });
  assert.equal(text(shell).trimEnd(), `${a.binding.workspace}\n${a.context.hostname}`);
  assert.equal(shell.details.remote.uri, a.binding.uri);
  const edit = a.session.agent.state.tools.find((tool) => tool.name === "edit");
  const prepared = edit.prepareArguments({ path: "proof.txt", edits: JSON.stringify([{ oldText: "alpha", newText: "ALPHA" }]) });
  const edited = await execute(a, "edit", prepared);
  assert(edited.details.diff.includes("ALPHA"));
  assert(text(await execute(a, "grep", { pattern: "ALPHA", path: "proof.txt" })).includes("ALPHA"));
  assert(text(await execute(a, "find", { pattern: "proof.txt" })).includes("proof.txt"));
  assert(text(await execute(a, "ls", {})).includes("proof.txt"));
  passed("all seven Pi tools, edit preparation and diffs use remote cwd; concurrent projects keep independent files");

  await assert.rejects(execute(a, "read", { path: "missing.txt" }), /ENOENT|not found/);
  await assert.rejects(execute(a, "bash", { command: "exit 23" }), /23/);
  passed("remote file and command failures reach Pi as tool errors");

  const controller = new AbortController();
  let progress = false;
  const command = execute(a, "bash", {
    command: "echo $$ > cancel.pid; echo started; sleep 60",
  }, controller.signal, (update) => { if (text(update).includes("started")) progress = true; });
  // Attach a rejection handler before cancellation to avoid an unhandled promise.
  const cancelled = assert.rejects(command);
  for (let i = 0; i < 80 && !progress; i++) await new Promise((done) => setTimeout(done, 100));
  assert(progress, "Pi progress did not cross both MCP adapters");
  const pid = Number(text(await execute(a, "read", { path: "cancel.pid" })).trim());
  controller.abort();
  await cancelled;
  let stopped = false;
  for (let i = 0; i < 50; i++) {
    try {
      await execute(a, "bash", { command: `if kill -0 ${pid} 2>/dev/null; then exit 9; fi` });
      stopped = true;
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  assert(stopped, "Cancelled shell is still running");
  passed("Pi progress and cancellation propagate to the remote shell");

  await execute(a, "edit", { path: "AGENTS.md", edits: [{ oldText: "alpha-marker-v1", newText: "alpha-marker-v2" }] });
  if (!values.model) {
    await assert.rejects(a.prompt("Check project context"), /model/i);
  } else {
    await a.prompt("Reply with the current project marker from your project instructions. Use no tools.");
    const response = a.session.state.messages.findLast((message) => message.role === "assistant");
    assert.equal(response.stopReason, "stop", response.errorMessage);
    assert(text(response).includes("alpha-marker-v2"));
    const sections = {};
    for (const message of a.session.state.messages) {
      if (message.role === "system") Object.assign(sections, message.sections);
    }
    assert(sections.cwd.includes(a.binding.uri));
    assert(!sections.docs.includes("node_modules/"));
  }
  assert(a.context.agents_files.some((file) => file.content.includes("alpha-marker-v2")));
  assert(a.session.systemPrompt.includes("alpha-marker-v2"));
  passed("project instructions refresh before the next turn");

  if (values.model) {
    const calls = [];
    const unsubscribe = a.session.subscribe((event) => {
      if (event.type === "tool_execution_end") calls.push({ name: event.toolName, is_error: event.isError });
    });
    try {
      await a.prompt(
        "Create model-proof.txt containing the current project marker from your instructions followed by a newline. " +
        "Use write, then edit to change 'marker' to 'verified', then read to confirm the exact content. " +
        "Use grep to find 'verified' in it, find to locate model-proof.txt, ls to list the project, " +
        "and bash with 'pwd; hostname' to check the environment. Report the file reference and content.",
      );
    } finally { unsubscribe(); }
    const response = a.session.state.messages.findLast((message) => message.role === "assistant");
    assert.equal(response.stopReason, "stop", response.errorMessage);
    assert.deepEqual(new Set(calls.filter((call) => !call.is_error).map((call) => call.name)), new Set(toolNames));
    const verified = text(await execute(a, "read", { path: "model-proof.txt" }));
    assert.equal(verified, "alpha-verified-v2\n");
    assert(!existsSync("model-proof.txt"));
    assert(text(response).includes(a.binding.uri));
    agentTask = { tool_calls: calls, verified_content: verified, response: text(response) };
    passed("a real Pi model uses native names and remote instructions to complete a seven-tool task");
  } else {
    // Persist an actual Pi transcript without requiring API credentials for this suite.
    a.session.sessionManager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Verified alpha workspace history" }],
      provider: "fixture", model: "fixture", api: "openai-completions", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
  }
  const file = a.session.sessionManager.getSessionFile();
  assert(existsSync(file));
  const oldMessages = JSON.parse(JSON.stringify(a.session.sessionManager.buildSessionContext().messages));
  await a.close();
  sessions.splice(sessions.indexOf(a), 1);
  const restored = await createRemoteSession({ ...aOptions, model: undefined, sessionFile: file });
  sessions.push(restored);
  assert.deepEqual(restored.binding, a.binding);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.session.sessionManager.buildSessionContext().messages)), oldMessages);
  if (values.model) assert.equal(`${restored.session.model.provider}/${restored.session.model.id}`, values.model);
  assert.equal(text(await execute(restored, "read", { path: "proof.txt" })), "ALPHA\n");
  passed("Pi's persisted conversation restores with the same workspace and file state");

  if (values.model) {
    await restored.close();
    sessions.splice(sessions.indexOf(restored), 1);
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(dirname(fileURLToPath(import.meta.url)), "remote-agent.mjs"),
      "--config", base.config, "--machine", base.machine, "--workspace", aOptions.workspace,
      "--state-dir", base.stateDir, "--agent-dir", base.agentDir,
      ...(base.python ? ["--python", base.python] : []),
      "--session", file, "--json", "--prompt",
      "What exact content did we verify in model-proof.txt earlier in this conversation? Reply from memory without tools.",
    ], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const resumed = JSON.parse(stdout);
    assert(!resumed.error);
    assert.deepEqual(resumed.binding, a.binding);
    assert.equal(resumed.session_file, file);
    assert(resumed.assistant.includes("alpha-verified-v2"));
    assert.equal(resumed.tool_calls.length, 0);
    agentTask.resume_reply = resumed.assistant;
    passed("the JSON CLI resumes its saved model and conversation to answer from history");
  }

  await assert.rejects(createRemoteSession({ ...bOptions, sessionFile: file }), /different remote workspace/);
  await assert.rejects(createRemoteSession({ ...aOptions, sessionFile: file + ".missing" }), /does not exist/);
  passed("restoring into another workspace or a missing session file is rejected");

  const missing = a.binding.workspace + "-missing";
  await assert.rejects(openWorkspace({ ...aOptions, workspace: missing }), /existing directory/);
  await execute(b, "bash", { command: `test ! -e '${missing.replaceAll("'", "'\\''")}'` });
  passed("a mistyped workspace fails without creating a new project directory");

  connection = await openWorkspace(aOptions);
  const first = await connection.client.callTool({ name: "machine_info", arguments: {} });
  const workerPid = first.structuredContent.pid;
  const lost = await connection.client.callTool({ name: "bash", arguments: { command: `kill -KILL ${workerPid}` } });
  assert(lost.isError);
  let recovered;
  for (let i = 0; i < 50; i++) {
    await new Promise((done) => setTimeout(done, 100));
    const result = await connection.client.callTool({ name: "machine_info", arguments: {} });
    if (!result.isError) { recovered = result.structuredContent; break; }
  }
  assert(recovered);
  assert.notEqual(recovered.pid, workerPid);
  assert.equal(recovered.workspace, a.binding.workspace);
  const after = await connection.fetchContext();
  assert.deepEqual(after.binding, a.binding);
  passed("a lost worker reconnects to the same bound workspace without replaying the failed command");

  const report = { checks, agent_host: hostname(), target_host: a.context.hostname,
    workspaces: [a.binding, b.binding], real_model: values.model ?? null,
    ...(agentTask ? { agent_task: agentTask } : {}) };
  if (values.output) writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await connection?.close();
  await Promise.all(sessions.map((remote) => remote.close()));
}

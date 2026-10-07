/** Exercise real Pi tools, cloud persistence, concurrent terminals and process failure. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CloudClient } from "./cloud-client.mjs";
import { CloudService } from "./cloud-service.mjs";

const { values } = parseArgs({ options: {
  config: { type: "string" }, machine: { type: "string" }, "workspace-a": { type: "string" },
  "cloud-workspace": { type: "string" }, "state-dir": { type: "string" }, "agent-dir": { type: "string" },
  python: { type: "string" }, model: { type: "string" }, output: { type: "string" },
} });
const root = dirname(fileURLToPath(import.meta.url));
const options = {
  ...values, stateDir: values["state-dir"], cloudWorkspace: values["cloud-workspace"], agentDir: values["agent-dir"],
};
const checks = [];
const passed = (message) => { checks.push(message); console.error("PASS " + message); };
const text = (result) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function tool(client, name, args, turnId = randomUUID()) {
  await client.mutate("tool", { name, args, turnId });
  const outcome = await client.waitTurn(turnId);
  assert.equal(outcome.status, "completed", outcome.error);
  return outcome.result;
}
function event(client, predicate) {
  return new Promise((resolve, reject) => {
    const listener = (message) => { if (predicate(message.event)) { cleanup(); resolve(message.event); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Expected cloud event did not arrive")); }, 20000);
    const cleanup = () => { clearTimeout(timer); client.off("event", listener); };
    client.on("event", listener);
  });
}

let service, a, b, viewer;
const cloudWorkspace = resolve(options.cloudWorkspace);
mkdirSync(cloudWorkspace, { recursive: true });
writeFileSync(join(cloudWorkspace, "AGENTS.md"), "Cloud-only project instruction: cloud-marker\n");
try {
  service = await new CloudService(options).start();
  assert.throws(() => new CloudService(options), /already owns/);
  assert.equal((await import("node:fs")).statSync(service.socketPath).mode & 0o777, 0o600);
  a = new CloudClient({ socket: service.socketPath, name: "A", machine: values.machine, workspace: values["workspace-a"] });
  b = new CloudClient({ socket: service.socketPath, name: "B", workspaceId: "cloud" });
  viewer = new CloudClient({ socket: service.socketPath, name: "Viewer", workspaceId: "cloud" });
  await Promise.all([a.connect(), b.connect(), viewer.connect()]);
  await a.request("attach");
  const sessionId = a.state.id;
  const workspaceA = a.state.focus;
  assert.notEqual(workspaceA, "cloud");
  assert.equal((await b.request("list")).length, 0);
  assert((await b.request("list", { all: true })).some((item) => item.id === sessionId));
  assert(existsSync(service.get(sessionId).file));
  passed("single cloud writer, private socket, durable new sessions and cross-machine resume discovery");

  await tool(a, "write", { path: "handoff.txt", content: "A\n" });
  const declared = service.get(sessionId).agent.session.getActiveToolNames();
  assert(declared.includes("cloud__write"));
  assert(declared.includes(`${workspaceA}__read`));
  assert(declared.includes("environment"));
  assert.equal(text(await tool(a, "read", { path: "handoff.txt" })), "A\n");
  if (service.environment.entries.has("archive")) {
    assert(declared.includes("archive__read"));
    assert.equal(text(await tool(a, "archive__read", { path: "handoff.txt" })), "A\n");
    assert((await tool(a, "archive__machine_info", {})).details.structuredContent.hostname);
    await assert.rejects(a.mutate("workspace", { workspaceId: "archive" }), /directory workspace/);
    passed("generic HTTP MCP tools join the same environment and preserve structured results");
  }
  await b.request("attach", { session: sessionId, mode: "view" });
  assert.equal(b.state.focus, workspaceA);
  assert.equal(b.state.canInput, false);
  await assert.rejects(b.mutate("tool", { name: "write", args: { path: "forbidden.txt", content: "bad" }, turnId: randomUUID() }), /Input control changed/);
  assert.deepEqual(b.state.messages, JSON.parse(JSON.stringify(service.manager(service.get(sessionId)).buildSessionContext().messages)));
  passed("B views the same history while the default workspace stays on A; viewers cannot mutate");

  const oldEpoch = a.state.epoch;
  const running = randomUUID();
  const started = event(a, (event) => event.type === "tool_execution_start");
  await a.mutate("tool", { name: "bash", args: { command: "sleep 1; printf 'HANDOFF\n' >> handoff.txt; pwd > during-turn.txt" }, turnId: running });
  await started;
  await b.request("take_control");
  assert(b.state.activeTools.some((tool) => tool.toolName === "bash" && tool.args.command.includes("HANDOFF")));
  await b.mutate("workspace", { workspaceId: "current" });
  assert.equal(b.state.focus, workspaceA);
  assert.equal(b.state.pendingFocus, "cloud");
  await assert.rejects(a.request("tool", { epoch: oldEpoch, name: "write", args: { path: "handoff.txt", content: "stale" }, turnId: randomUUID() }), /Input control changed/);
  assert.equal((await b.waitTurn(running)).status, "completed");
  await b.request("snapshot");
  assert.equal(b.state.focus, "cloud");
  assert.equal(text(await tool(b, `${workspaceA}__read`, { path: "handoff.txt" })), "A\nHANDOFF\n");
  assert.equal(text(await tool(b, `${workspaceA}__read`, { path: "during-turn.txt" })).trim(), values["workspace-a"]);
  assert.equal((await b.mutate("tool", { name: "bash", args: { command: "printf 'DUPLICATED\n' >> handoff.txt" }, turnId: running })).duplicate, true);
  assert(!existsSync(join(cloudWorkspace, "handoff.txt")));
  await tool(b, "write", { path: "handoff.txt", content: "B-CLOUD\n" });
  assert.equal(readFileSync(join(cloudWorkspace, "handoff.txt"), "utf8"), "B-CLOUD\n");
  passed("control handoff fences stale input, keeps in-flight tools on A, applies focus next turn and deduplicates commands");

  const sourceMessages = (await b.request("snapshot")).messages;
  await b.mutate("fork");
  const forkId = b.state.id;
  assert.notEqual(forkId, sessionId);
  assert.equal(b.state.parentId, sessionId);
  assert.deepEqual(b.state.messages, sourceMessages);
  await tool(b, "write", { path: "fork-only.txt", content: "FORK\n" });
  await viewer.request("attach", { session: sessionId, mode: "view" });
  assert(!viewer.state.messages.some((message) => textContent(message).includes("fork-only.txt")));
  assert.equal(viewer.state.id, sessionId);
  passed("explicit fork has a new session identity and independent history while resume keeps one identity");

  const cancelled = randomUUID();
  const cancellingStarted = event(b, (event) => event.type === "tool_execution_start");
  await b.mutate("tool", { name: "bash", args: { command: "echo $$ > cancel.pid; sleep 20; touch cancel-finished" }, turnId: cancelled });
  await cancellingStarted;
  for (let attempt = 0; attempt < 100 && !existsSync(join(cloudWorkspace, "cancel.pid")); attempt++) await sleep(20);
  await b.mutate("cancel");
  assert.equal((await b.waitTurn(cancelled)).status, "cancelled");
  assert(!existsSync(join(cloudWorkspace, "cancel-finished")));
  const pid = Number(readFileSync(join(cloudWorkspace, "cancel.pid"), "utf8"));
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch { break; }
    await sleep(20);
  }
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  passed("explicit cancellation stops the real Pi subprocess and differs from detaching a terminal");

  await a.request("take_control");
  await a.mutate("workspace", { workspaceId: workspaceA });
  await b.mutate("workspace", { workspaceId: workspaceA });
  const survivor = randomUUID(), sharedCancel = randomUUID();
  const survivorStarted = event(a, (event) => event.type === "tool_execution_start");
  const sharedStarted = event(b, (event) => event.type === "tool_execution_start");
  await a.mutate("tool", { name: "bash", args: { command: "sleep 1; printf 'SURVIVED\n' > survivor.txt" }, turnId: survivor });
  await survivorStarted;
  const cancelledRefresh = new AbortController();
  cancelledRefresh.abort(new Error("Cancelled workspace preparation"));
  await assert.rejects(service.environment.refresh(workspaceA, cancelledRefresh.signal), /Cancelled workspace preparation/);
  await b.mutate("tool", { name: "bash", args: { command: "sleep 20; touch should-not-finish" }, turnId: sharedCancel });
  await sharedStarted;
  await b.mutate("cancel");
  assert.equal((await b.waitTurn(sharedCancel)).status, "cancelled");
  assert.equal((await a.waitTurn(survivor)).status, "completed");
  assert.equal(text(await tool(a, "read", { path: "survivor.txt" })), "SURVIVED\n");
  await b.mutate("workspace", { workspaceId: "cloud" });
  passed("cancelling workspace preparation or a tool leaves other sessions running on the shared connection");

  await a.request("attach", { session: sessionId });
  await a.mutate("workspace", { workspaceId: workspaceA });
  const detached = randomUUID();
  const detachStarted = event(a, (event) => event.type === "tool_execution_start");
  await a.mutate("tool", { name: "bash", args: { command: "sleep 0.5; printf 'AFTER-DETACH\n' > detached.txt" }, turnId: detached });
  await detachStarted;
  const resetPeer = connect(service.socketPath);
  resetPeer.on("error", () => {});
  await new Promise((resolve) => resetPeer.once("connect", resolve));
  resetPeer.write(JSON.stringify({ id: "reset-attach", command: "attach", session: sessionId, mode: "view" }) + "\n" +
    Array.from({ length: 100 }, (_, index) => JSON.stringify({ id: `reset-${index}`, command: "snapshot" }) + "\n").join(""));
  await sleep(20);
  resetPeer.destroy(); // Close with unread server responses, as a killed SSH bridge does.
  a.close();
  assert.equal((await viewer.waitTurn(detached)).status, "completed");
  await viewer.request("take_control");
  assert.equal(text(await tool(viewer, "read", { path: "detached.txt" })), "AFTER-DETACH\n");
  passed("terminal exit releases input control while cloud execution and tool connections survive");

  await assert.rejects(viewer.mutate("workspace", { workspaceId: "missing" }), /Unknown workspace/);
  const invalid = randomUUID();
  await viewer.mutate("tool", { name: "write", args: { path: "illegal.txt", content: 42 }, turnId: invalid });
  assert.equal((await viewer.waitTurn(invalid)).status, "failed");
  const paths = text(await tool(viewer, "ls", {}));
  assert(!paths.includes("illegal.txt"));
  passed("unknown workspaces and invalid native tool arguments fail without mutating files");

  await service.environment.disconnect(workspaceA);
  const entry = service.environment.get(workspaceA);
  const originalMachine = entry.machine;
  entry.machine = "unreachable-fixture";
  const unavailable = randomUUID();
  await viewer.mutate("tool", { name: "read", args: { path: "handoff.txt" }, turnId: unavailable });
  assert.equal((await viewer.waitTurn(unavailable)).status, "failed");
  assert.equal((await viewer.request("snapshot")).focus, workspaceA);
  assert((await viewer.request("list", { all: true })).some((item) => item.id === sessionId));
  assert.equal(text(await tool(viewer, "cloud__read", { path: "handoff.txt" })), "B-CLOUD\n");
  entry.machine = originalMachine;
  service.environment.save();
  assert.equal(text(await tool(viewer, "read", { path: "handoff.txt" })), "A\nHANDOFF\n");
  passed("an unavailable target retains history and focus; cloud tools still work and later target calls reconnect");

  b.close(); viewer.close();
  const oldRecordEpoch = service.get(sessionId).epoch;
  const savedMessages = JSON.parse(JSON.stringify(service.manager(service.get(sessionId)).buildSessionContext().messages));
  await service.close();
  const metadataFile = join(options.stateDir, "records", `${sessionId}.json`);
  const staleMetadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  const completedEntry = service.manager(service.get(sessionId)).getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "cloud-turn");
  staleMetadata.status = "running";
  staleMetadata.currentTurn = { id: completedEntry.data.id, focus: workspaceA, command: "tool" };
  writeFileSync(metadataFile, JSON.stringify(staleMetadata));
  service = await new CloudService({ ...options, model: undefined }).start();
  b = new CloudClient({ socket: service.socketPath, name: "B-reconnected", workspaceId: "cloud" });
  await b.connect();
  await b.request("attach", { session: sessionId });
  assert.deepEqual(b.state.messages, savedMessages);
  assert(b.state.epoch > oldRecordEpoch);
  assert.equal(b.state.focus, workspaceA);
  assert.equal(b.state.status, "idle");
  assert((await b.request("list", { all: true })).some((item) => item.id === forkId));
  await assert.rejects(b.request("tool", { epoch: oldRecordEpoch, name: "write", args: { path: "stale-restart.txt", content: "bad" }, turnId: randomUUID() }), /Input control changed/);
  passed("service restart restores native history, focus, forks and fresh input epochs");

  // Verify the launcher delegates local Pi normally and can inspect/resume cloud sessions.
  const cli = spawn(process.execPath, [join(root, "pi.mjs"), "--remote", "--socket", service.socketPath,
    "--workspace-id", "cloud", "--session", sessionId, "--inspect"], { stdio: ["ignore", "pipe", "pipe"] });
  let cliOutput = "", cliError = "";
  cli.stdout.on("data", (data) => { cliOutput += data; }); cli.stderr.on("data", (data) => { cliError += data; });
  assert.equal(await new Promise((resolve) => cli.once("exit", resolve)), 0, cliError);
  assert.equal(JSON.parse(cliOutput).id, sessionId);
  await b.request("take_control");
  passed("pi --remote attaches an existing cloud session without a local model configuration");

  if (values.model) {
    const turnId = randomUUID();
    const calls = [];
    const collect = (message) => { if (message.event.type === "tool_execution_end") calls.push(message.event); };
    b.on("event", collect);
    await b.mutate("prompt", { turnId, text:
      "Verify this environment using tools. Read AGENTS.md. Write model-proof.txt with the current project marker from your project instructions followed by a newline. " +
      "Use edit to replace 'marker' with 'verified' in model-proof.txt, then read it. Use grep to find 'verified', find to locate model-proof.txt, ls to list the project, and bash to run pwd and hostname. " +
      "Also use cloud__write to write cloud-proof.txt with exactly 'cloud-verified\\n', and cloud__bash to run pwd and hostname on the cloud server. " +
      "Report the exact verified file content and machine-qualified locations. Use each of the seven ordinary tools and the two explicit cloud tools. Do not delegate." });
    const outcome = await b.waitTurn(turnId);
    assert.equal(outcome.status, "completed", outcome.error);
    const required = ["read", "write", "edit", "bash", "grep", "find", "ls", "cloud__write", "cloud__bash"];
    const missing = required.filter((name) => !calls.some((call) => call.toolName === name && !call.isError));
    if (missing.length) {
      const followUp = randomUUID();
      await b.mutate("prompt", { turnId: followUp, text: `The verification still needs these exact tool calls: ${missing.join(", ")}. ` +
        "For cloud__write, write cloud-proof.txt containing exactly cloud-verified followed by a newline. For cloud__bash, run pwd and hostname. Complete the missing calls now." });
      const extra = await b.waitTurn(followUp);
      assert.equal(extra.status, "completed", extra.error);
    }
    b.off("event", collect);
    console.error("Model tools: " + calls.map((call) => call.toolName + (call.isError ? " (error)" : "")).join(", "));
    for (const name of required) assert(calls.some((call) => call.toolName === name && !call.isError), name);
    assert.equal(text(await tool(b, "read", { path: "model-proof.txt" })), "alpha-verified-v1\n");
    assert.equal(readFileSync(join(cloudWorkspace, "cloud-proof.txt"), "utf8"), "cloud-verified\n");
    const sections = Object.assign({}, ...service.get(sessionId).agent.session.messages.filter((message) => message.role === "system").map((message) => message.sections));
    assert(sections.remote_workspace.includes(service.environment.get(workspaceA).context.binding.uri));
    assert(!sections.contextFiles?.includes("cloud-marker"));
    await b.request("detach");
    await b.request("attach", { session: sessionId });
    const memoryTurn = randomUUID();
    const memoryCalls = [];
    const memoryCollect = (message) => { if (message.event.type === "tool_execution_end") memoryCalls.push(message.event); };
    b.on("event", memoryCollect);
    await b.mutate("prompt", { turnId: memoryTurn, text: "What exact content did we verify in model-proof.txt? Answer from our conversation history without calling tools." });
    const memory = await b.waitTurn(memoryTurn);
    b.off("event", memoryCollect);
    assert.equal(memory.status, "completed", memory.error);
    assert(memory.result.assistant.includes("alpha-verified-v1"));
    assert.equal(memoryCalls.length, 0);
    passed("a real cloud Pi model uses all native workspace tools plus cloud tools and resumes conversation memory");
  }

  // SIGKILL gives no cleanup opportunity: startup must mark interruption and never replay.
  const crashState = mkdtempSync(join(tmpdir(), "remote-pi-crash-"));
  const crashWorkspace = join(cloudWorkspace, "crash-fixture");
  mkdirSync(crashWorkspace);
  const child = spawn(process.execPath, [join(root, "cloud-service.mjs"), "--state-dir", crashState, "--cloud-workspace", crashWorkspace, "--agent-dir", options.agentDir], { stdio: "ignore" });
  const childExit = new Promise((resolve) => child.once("exit", resolve));
  let crashClient, recovered;
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(join(crashState, "service.sock")); attempt++) await sleep(30);
    crashClient = new CloudClient({ socket: join(crashState, "service.sock"), name: "Crash terminal" });
    await crashClient.connect(); await crashClient.request("attach");
    const crashId = crashClient.state.id;
    const crashTurn = randomUUID();
    await crashClient.mutate("tool", { name: "bash", args: { command: "printf 'ONCE\n' >> before-crash.txt; sleep 20; touch after-crash.txt" }, turnId: crashTurn });
    for (let attempt = 0; attempt < 200 && !existsSync(join(crashWorkspace, "before-crash.txt")); attempt++) await sleep(20);
    assert(existsSync(join(crashWorkspace, "before-crash.txt")));
    child.kill("SIGKILL"); await childExit; crashClient.close();
    await sleep(11000); // The cloud writer's heartbeat lock expires after a hard kill.
    recovered = await new CloudService({ stateDir: crashState, cloudWorkspace: crashWorkspace, agentDir: options.agentDir }).start();
    crashClient = new CloudClient({ socket: recovered.socketPath });
    await crashClient.connect(); await crashClient.request("attach", { session: crashId });
    assert.equal(crashClient.state.status, "interrupted");
    assert.equal((await crashClient.mutate("tool", { name: "bash", args: { command: "touch replayed.txt" }, turnId: crashTurn })).status, "interrupted");
    assert.equal(readFileSync(join(crashWorkspace, "before-crash.txt"), "utf8"), "ONCE\n");
    assert(!existsSync(join(crashWorkspace, "replayed.txt")));
    passed("a killed cloud process recovers an interrupted session without replaying uncertain operations");
  } finally { child.kill("SIGTERM"); crashClient?.close(); await recovered?.close(); rmSync(crashState, { recursive: true, force: true }); }

  const report = { checks, agent_host: hostname(), real_model: values.model ?? null, sessions: (await b.request("list", { all: true })).map((item) => ({ id: item.id, focus: item.focus, status: item.status })) };
  if (values.output) writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
  else console.log(JSON.stringify(report, null, 2));
} finally {
  a?.close(); b?.close(); viewer?.close(); await service?.close();
}

function textContent(message) {
  return typeof message.content === "string" ? message.content : message.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
}

/** Real SSH workers: directory recovery must not close a session's native tools. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DirectoryBrowser } from "./directory-browser.mjs";
import { Environment } from "./environment.mjs";
import { openWorkspace } from "./remote-agent.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input), execute = promisify(execFile);
const cloud = join(fixture.state, "cloud"), state = join(fixture.state, "state");
await mkdir(cloud); await mkdir(state);
await writeFile(join(fixture.workspace, "proof.txt"), "NATIVE-SESSION-STILL-WORKS\n");
const environment = new Environment({ stateDir: state, config: fixture.config, python: fixture.python, cloudWorkspace: cloud });
const browser = new DirectoryBrowser(environment, { readTimeout: 800 });
const paused = new Set(), checks = [];
const passed = (message) => { checks.push(message); console.log("PASS " + message); };
const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
async function browserWorker() {
  const { stdout } = await execute("ps", ["-eo", "pid,stat,args"]);
  const worker = stdout.split("\n").find((line) => line.trim().endsWith(`${fixture.bundle}/worker.mjs --workspace /`) && !/[TZ]/.test(line.trim().split(/\s+/)[1]));
  assert.ok(worker, "The browser must have a real separate SSH worker");
  return Number(worker.trim().split(/\s+/)[0]);
}
function resume(pid) {
  try { process.kill(pid, "SIGCONT"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  paused.delete(pid);
}
async function listing(path = fixture.workspace, signal) {
  const result = await browser.list("laptop", "/", path, signal);
  assert.equal(result.absolutePath, path);
  return result;
}

try {
  const id = await environment.register("laptop", fixture.workspace);
  const native = await environment.connect(id);
  const saved = await readFile(environment.file, "utf8");
  const first = await listing();
  assert.ok(first.entries.some((entry) => entry.name === "proof.txt"));
  assert.equal(await readFile(environment.file, "utf8"), saved);
  assert.equal([...browser.connections.values()][0].connection.context, undefined);
  assert.notEqual([...browser.connections.values()][0].connection, native);
  passed("browsing uses a separate real worker, skips project context and never registers a root workspace");

  const originalPid = await browserWorker();
  const warm = performance.now();
  await listing();
  assert.equal(await browserWorker(), originalPid);
  assert.ok(performance.now() - warm < 2000);
  await assert.rejects(listing(join(fixture.workspace, "missing-folder")), /ENOENT|no such/i);
  assert.equal(await browserWorker(), originalPid);
  passed("warm directory reads reuse their worker; a missing directory preserves its connection");

  process.kill(originalPid, "SIGSTOP"); paused.add(originalPid);
  const controller = new AbortController();
  const cancelled = settled(listing(fixture.workspace, controller.signal));
  await delay(150); controller.abort(new Error("dialog closed"));
  assert.match((await cancelled).error.message, /dialog closed/);
  resume(originalPid); await listing();
  assert.equal(await browserWorker(), originalPid);
  passed("cancelling one dialog leaves a shared browser worker usable by another dialog");

  process.kill(originalPid, "SIGSTOP"); paused.add(originalPid);
  const descriptor = environment.descriptors(id).find((tool) => tool.name === "bash");
  const nativeJob = settled(environment.definition(id, descriptor).execute("native-during-browser-recovery", { command: "sleep 1; cat proof.txt" }));
  const started = performance.now();
  const recovered = await Promise.all([listing(), listing()]);
  assert.equal(recovered.length, 2);
  assert.ok(performance.now() - started < 15000, "read timeouts must recover without asking the user to retry");
  const newPid = await browserWorker();
  assert.notEqual(newPid, originalPid);
  const nativeResult = await nativeJob;
  assert.ifError(nativeResult.error);
  assert.ok(nativeResult.value.content.some((item) => item.text?.includes("NATIVE-SESSION-STILL-WORKS")));
  assert.equal(environment.connections.get(id), native);
  resume(originalPid);
  passed("two timed-out directory reads share recovery while an existing session's native command completes");

  process.kill(newPid, "SIGKILL");
  await delay(150);
  await listing();
  assert.notEqual(await browserWorker(), newPid);
  passed("a dead directory worker is transparently replaced on the next read");

  const sockets = new Set();
  const blackhole = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("data", () => {}); });
  await new Promise((done) => blackhole.listen(0, "127.0.0.1", done));
  try {
    const config = JSON.parse(await readFile(fixture.config, "utf8"));
    config.targets.pending = { kind: "bridge", host: "pending-device", port: blackhole.address().port, token: "fixture-only", workspace: fixture.workspace };
    const file = join(fixture.state, "pending-targets.json");
    await writeFile(file, JSON.stringify(config));
    const start = performance.now();
    await assert.rejects(openWorkspace({ config: file, machine: "pending", python: fixture.python, readContext: false, connectTimeout: 1200 }), /connection timed out/);
    assert.ok(performance.now() - start < 6000, "initialization and discovery share one deadline");
    passed("an unresponsive device bootstrap has a bounded initialization and discovery deadline");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => blackhole.close(done));
  }
  assert.equal(await readFile(environment.file, "utf8"), saved);
  console.log(JSON.stringify({ checks, modelRequests: 0 }));
} finally {
  for (const pid of paused) resume(pid);
  await browser.close();
  await environment.close();
}

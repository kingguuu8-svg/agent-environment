/** Compare the shipped native search with DSH, then exercise worker updates and routing races. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readWorkspaceFile } from "./workspace-files.mjs";
import { RemoteWorkspaces } from "./dsh-product/plugin/host.mjs";

const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const upstream = await import(require.resolve("@deepseek-ai/dsh-file-reference-local/search"));
const base = await mkdtemp(join(tmpdir(), "workspace-references-")), root = join(base, "root");
const signal = new AbortController().signal;
const client = new Client({ name: "reference-verifier", version: "0.1.0" });
const search = new upstream.WorkspaceFileSearch(root, { maxResults: upstream.DEFAULT_FILE_SEARCH_MAX_RESULTS,
  maxEntries: upstream.DEFAULT_FILE_SEARCH_MAX_ENTRIES, excludedDirectories: upstream.DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES });
let checks = 0;
const passed = (name) => { checks++; console.log("PASS " + name); };
const list = (query) => readWorkspaceFile(root, { op: "references", query }, signal);
try {
  await mkdir(root); await mkdir(join(root, "nested space")); await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "说明 空格.txt"), "中文\n"); await writeFile(join(root, ".hidden.txt"), "hidden");
  await writeFile(join(root, "nested space", "code.js"), "nested");
  await writeFile(join(root, "node_modules", "ignored.js"), "dependency");
  await mkdir(join(base, "outside")); await writeFile(join(base, "outside", "private.txt"), "outside");
  await symlink(join(base, "outside"), join(root, "linked"), "dir");
  for (let index = 0; index < 35; index++) await writeFile(join(root, `item-${index}.txt`), String(index));
  for (const query of ["", "code", "说明", "nested space/", ".hidden", "item-", "../outside/", "linked/", "node_modules/"]) {
    assert.deepEqual(await list(query), await search.list(query, signal));
  }
  assert.equal((await list("item-")).length, 20);
  passed("the shipped engine matches native DSH ranking, drilling, exclusions and bounded results");

  await assert.rejects(() => readWorkspaceFile(root, { op: "references", query: "\0" }, signal), /Invalid/);
  await assert.rejects(() => readWorkspaceFile(root, { op: "references", query: 1 }, signal), /Invalid/);
  await assert.rejects(() => readWorkspaceFile(root, { op: "references", query: "x".repeat(4097) }, signal), /Invalid/);
  const canceled = new AbortController(); canceled.abort(new Error("reference query canceled"));
  await assert.rejects(() => readWorkspaceFile(root, { op: "references", query: "" }, canceled.signal), /canceled/);
  passed("malformed and canceled queries cannot start or return a search");

  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./worker.mjs", import.meta.url)), "--workspace", root], stderr: "pipe" });
  await client.connect(transport);
  const remoteList = async (query, requestSignal) => {
    const uri = `workspace://files?request=${encodeURIComponent(JSON.stringify({ op: "references", query }))}`;
    return JSON.parse((await client.readResource({ uri }, { signal: requestSignal })).contents[0].text);
  };
  assert.deepEqual(await remoteList("说明"), [{ path: "说明 空格.txt", kind: "file" }]);
  passed("actual worker MCP resources return only path candidates and keep model tools unchanged");
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["read", "write", "edit", "bash", "grep", "find", "ls", "machine_info"]);
  const result = await client.callTool({ name: "write", arguments: { path: "after-tool.txt", content: "NEW-FILE\n" } });
  assert.ok(!result.isError);
  let latest;
  const deadline = Date.now() + 3000;
  do { latest = await remoteList("after-tool"); if (latest.length === 0) await delay(10); } while (latest.length === 0 && Date.now() < deadline);
  assert.deepEqual(latest, [{ path: "after-tool.txt", kind: "file" }]);
  assert.ok((await remoteList("")).some((entry) => entry.path === "after-tool.txt"));
  passed("a native Pi write invalidates the worker's fuzzy index and directory reads see the new file");
  await assert.rejects(() => remoteList("item-", canceled.signal), /canceled/);
  assert.deepEqual(await remoteList("after-tool"), latest);
  passed("one canceled MCP query leaves the shared search and worker usable");

  let binding = { id: "remote", machine: "remote", workspace: root }, complete;
  const agent = { session: {} }, cleanups = [];
  const original = async () => search.list("说明", signal);
  const references = { list: original };
  const service = { host: { fileReferences: references, effect(register) { cleanups.push(register()); } },
    state() { return { current: binding }; }, fileRequest() { return new Promise((resolve) => { complete = resolve; }); } };
  RemoteWorkspaces.prototype.installReferenceRouting.call(service);
  const late = references.list(agent, "说明", signal);
  binding = { id: "new-target", machine: "new-target", workspace: "/other" };
  complete(await list("说明"));
  assert.deepEqual(await late, []);
  passed("a remote response from before handoff cannot publish candidates for the new execution target");
  const abort = new AbortController();
  const pending = references.list(agent, "说明", abort.signal);
  abort.abort(new Error("query stopped")); complete(await list("说明"));
  await assert.rejects(() => pending, /query stopped/);
  binding = null;
  assert.deepEqual(await references.list(agent, "说明", signal), [{ path: "说明 空格.txt", kind: "file" }]);
  for (const dispose of cleanups) dispose();
  assert.equal(references.list, original);
  passed("cancellation, ordinary local DSH and plugin teardown preserve their native behavior");
  console.log(JSON.stringify({ checks, passed: true }));
} finally {
  search.dispose();
  await client.close();
  await rm(base, { recursive: true, force: true });
}

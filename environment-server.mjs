#!/usr/bin/env node
/** Environment-only entry: native target tools without a model or DSH installation. */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import lockfile from "proper-lockfile";
import { Environment, readJson } from "./environment.mjs";
import { startEnvironmentAccess } from "./environment-access.mjs";

const { values } = parseArgs({ options: {
  state: { type: "string" }, targets: { type: "string" }, workspace: { type: "string" },
  python: { type: "string" }, access: { type: "string" },
} });
for (const option of ["state", "targets", "workspace", "access"]) {
  if (!values[option]) throw new Error(`Missing --${option}`);
}
const stateDir = resolve(values.state);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
// A registry has one writer. The DSH Host already owns its own process lock.
const release = await lockfile.lock(stateDir, { stale: 10000, update: 2000, retries: 0 });
let environment, access, closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    await access?.close();
    await environment?.close();
    await release();
  })();
  return closing;
}
try {
  environment = new Environment({ stateDir, config: values.targets, python: values.python, cloudWorkspace: values.workspace });
  access = await startEnvironmentAccess({
    configFile: values.access, environment,
    reloadTargets: () => { environment.configuration = readJson(environment.config); },
    callTool: async (id, name, args, signal) => {
      const descriptor = environment.descriptors(id).find((tool) => tool.name === name);
      if (!descriptor) throw new Error(`Unknown tool ${name} on ${id}`);
      const result = await environment.definition(id, descriptor).execute(randomUUID(), args, signal);
      return { content: result.content,
        ...(environment.get(id).kind !== "mcp" ? { _meta: { "remote/pi": result.details } } : {}),
        ...(result.details?.structuredContent ? { structuredContent: result.details.structuredContent } : {}) };
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    void close().catch((error) => { process.stderr.write(`Shutdown: ${error.message}\n`); process.exitCode = 1; });
  });
  process.stdout.write(`Environment ready: ${readJson(values.access).url}\n`);
} catch (error) {
  await close();
  throw error;
}

#!/usr/bin/env node
/** Host launcher: keep the browser launch capability in a private file for SSH clients. */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeJson } from "./environment.mjs";
const { values } = parseArgs({ options: { home: { type: "string" }, workspace: { type: "string" }, state: { type: "string" }, port: { type: "string", default: "3080" } } });
for (const option of ["home", "workspace", "state"]) if (!values[option]) throw new Error(`Missing --${option}`);
const state = resolve(values.state);
mkdirSync(state, { recursive: true, mode: 0o700 });
const child = spawn(process.execPath, [fileURLToPath(new URL("./dsh-product/node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url)), "--profile", "remote-web", "--port", values.port, "--no-open"], {
  cwd: resolve(values.workspace), env: { ...process.env, DSH_HOME: resolve(values.home), DSH_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    const url = line.match(/http:\/\/[^\s]+\?token=[^\s]+/)?.[0];
    if (url) writeJson(join(state, "web-url.json"), { url, pid: child.pid });
    process.stderr.write(line.replace(/([?&]token=)[^\s&]+/g, "$1[private]") + "\n");
  });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });

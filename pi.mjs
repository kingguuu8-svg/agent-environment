#!/usr/bin/env node
/** Keep the ordinary upstream Pi command; --remote selects the cloud frontend. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const entry = remote ? fileURLToPath(new URL("./pi-remote.mjs", import.meta.url))
  : join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const child = spawn(process.execPath, [entry, ...args.filter((arg) => arg !== "--remote")], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });

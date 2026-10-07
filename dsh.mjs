#!/usr/bin/env node
/** --remote chooses the cloud product; ordinary DSH still delegates to its installation. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./state-json.mjs";
const args = process.argv.slice(2);
const remote = args.includes("--remote");
let command, forwarded;
if (remote) {
  if (args[0] !== "web") throw new Error("Use dsh web --remote");
  command = [process.execPath, fileURLToPath(new URL("./dsh-remote.mjs", import.meta.url))];
  forwarded = args.slice(1).filter((arg) => arg !== "--remote");
} else {
  const profile = readJson(process.env.REMOTE_DSH_PROFILE ?? join(homedir(), ".config/remote-dsh/client.json"), {});
  const native = fileURLToPath(new URL("./dsh-product/node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url));
  command = profile.nativeCommand ?? (existsSync(native) ? [process.execPath, native] : null);
  if (!command) throw new Error("Local DSH is not installed. Use dsh web --remote");
  forwarded = args;
}
// Windows batch launchers require cmd.exe; remote Node entry stays direct.
const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command[0]);
const child = spawn(command[0], [...command.slice(1), ...forwarded], { stdio: "inherit", shell });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });

#!/usr/bin/env node
/** Restricted SSH entry: validate this device's directory and return the Web launch capability. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
const { values } = parseArgs({ options: { state: { type: "string" }, machine: { type: "string" } } });
if (!values.state) throw new Error("Missing state directory");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
lines.on("line", async (line) => {
  if (initialized) return;
  initialized = true;
  try {
    if (line.length > 16384) throw new Error("Entry request is too large");
    const request = JSON.parse(line);
    const { url } = JSON.parse(readFileSync(join(values.state, "web-url.json"), "utf8"));
    const parsed = new URL(url);
    const machine = values.machine;
    let workspace;
    if (machine && request.workspace) {
      const login = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
      const cookie = login.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
      if (!cookie || ![302, 303].includes(login.status)) throw new Error("Cloud Web service is not ready; retry the launcher");
      const endpoint = "remoteWorkspaces/pick";
      const response = await fetch(`${parsed.origin}/api/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: parsed.origin }, body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: endpoint, payload: { args: { request: { machine, workspace: request.workspace } } } }), signal: AbortSignal.timeout(300000) });
      const result = (await response.json()).result;
      if (!result.ok) throw new Error(result.error.message);
      workspace = result.value.binding.workspace;
    }
    process.stdout.write(JSON.stringify({ type: "ready", url, machine: machine ?? "cloud", ...(workspace ? { workspace } : {}) }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: "error", error: error.message }) + "\n");
    lines.close(); process.exitCode = 1;
  }
});
lines.on("close", () => { process.stdin.pause(); });

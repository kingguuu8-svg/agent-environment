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
    let workspace, onboarding, onboardingError;
    if (machine && (request.workspace || request.pairingId)) {
      const login = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
      const cookie = login.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
      if (!cookie || ![302, 303].includes(login.status)) throw new Error("Cloud Web service is not ready; retry the launcher");
      const call = async (method, request, timeout) => {
        const endpoint = `remoteWorkspaces/${method}`;
        const response = await fetch(`${parsed.origin}/api/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: parsed.origin }, body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: endpoint, payload: { args: { request } } }), signal: AbortSignal.timeout(timeout) });
        const result = (await response.json()).result;
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      };
      if (request.pairingId) {
        try { onboarding = await call("deviceInstallerConfirm", { machine, pairingId: request.pairingId }, 10000); }
        catch (error) { onboardingError = error.message; }
      }
      if (request.workspace) workspace = (await call("pick", { machine, workspace: request.workspace }, 300000)).binding.workspace;
    }
    process.stdout.write(JSON.stringify({ type: "ready", url, machine: machine ?? "cloud", ...(workspace ? { workspace } : {}), ...(onboarding ? { onboarding } : {}), ...(onboardingError ? { onboardingError } : {}) }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: "error", error: error.message }) + "\n");
    lines.close(); process.exitCode = 1;
  }
});
lines.on("close", () => { process.stdin.pause(); });

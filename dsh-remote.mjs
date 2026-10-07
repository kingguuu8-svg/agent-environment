#!/usr/bin/env node
/** Device Web entry. Model execution and session storage stay on VPS4. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readJson, writeJson } from "./environment.mjs";
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const { values } = parseArgs({ options: { workspace: { type: "string" }, port: { type: "string" }, "no-open": { type: "boolean" }, profile: { type: "string" }, foreground: { type: "boolean" }, "connection-only": { type: "boolean" } } });
const profileFile = resolve(values.profile ?? process.env.REMOTE_DSH_PROFILE ?? join(homedir(), ".config/remote-dsh/client.json"));
const profile = readJson(profileFile);
if (!profile) throw new Error("Run the DSH device installer first");
const workspace = profile.machine && !values["connection-only"] ? realpathSync(resolve(values.workspace ?? process.cwd())) : undefined;
function launchUrl(ready, port) {
  const url = new URL(ready.url);
  url.host = `127.0.0.1:${port}`;
  // DSH exchanges the query token and redirects to ./; browsers preserve the
  // fragment across that redirect, so the invoking device hint survives login.
  const hint = new URLSearchParams({ remote: "1", machine: ready.machine });
  if (workspace ?? ready.workspace) hint.set("workspace", workspace ?? ready.workspace);
  url.hash = hint.toString();
  return url.href;
}
function open(url) {
  const connection = values.foreground && !values["connection-only"] ? "关闭此终端会断开 Web 转发。" : profile.localState ? "当前入口直接访问云端 Host。" : "本机连接由用户服务保持。";
  process.stdout.write(`云端 DSH 已连接：${url}\n会话和 Agent 在 VPS4 运行；${connection}\n`);
  if (!values["no-open"] && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    const browser = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    browser.on("error", () => {}); browser.unref();
  }
}
if (profile.localState) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./dsh-entry.mjs", import.meta.url)), "--state", profile.localState, "--machine", profile.machine ?? "cloud"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  lines.once("line", (line) => {
    const ready = JSON.parse(line);
    if (ready.type !== "ready") throw new Error(ready.error);
    open(launchUrl(ready, new URL(ready.url).port)); child.stdin.end();
  });
  child.stdin.write(JSON.stringify({ workspace }) + "\n");
} else {
  const cloud = profile.cloud;
  if (!cloud?.host || cloud.host.startsWith("-")) throw new Error("Configure the cloud SSH host");
  const cacheDir = join(homedir(), ".cache/remote-dsh"); mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const id = createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 16);
  const cacheFile = join(cacheDir, id + ".json");
  if (!values.foreground) {
    const unitName = `remote-dsh-web-${id}.service`;
    const directory = join(homedir(), ".config/systemd/user"); mkdirSync(directory, { recursive: true });
    const unitFile = join(directory, unitName);
    const port = Number(values.port ?? profile.localPort ?? 3081);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local port");
    const systemctl = (...args) => {
      const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr?.trim() || "User service manager is unavailable; use --foreground");
      return result.stdout.trim();
    };
    // The persistent tunnel has no workspace of its own. A later CLI invocation
    // can select a new directory even if an earlier directory/device is offline.
    const command = [process.execPath, fileURLToPath(import.meta.url), "--foreground", "--no-open", "--connection-only", "--profile", profileFile, "--port", String(port)];
    const unit = ["# remote-dsh managed Web tunnel", "[Unit]", "Description=Remote DSH Web connection", "After=network-online.target", "", "[Service]", "Type=simple", "ExecStart=" + command.map((part) => JSON.stringify(part.replaceAll("%", "%%"))).join(" "), "StandardOutput=null", "Restart=on-failure", "RestartSec=12", "", "[Install]", "WantedBy=default.target", ""].join("\n");
    if (!existsSync(unitFile) || readFileSync(unitFile, "utf8") !== unit) {
      if (existsSync(unitFile) && !readFileSync(unitFile, "utf8").includes("# remote-dsh managed Web tunnel")) throw new Error("Unmanaged Web tunnel service already exists");
      writeFileSync(unitFile, unit, { mode: 0o600 });
      systemctl("daemon-reload"); systemctl("enable", unitName); systemctl("restart", unitName);
    } else systemctl("start", unitName);
    const deadline = Date.now() + 300000;
    let refreshed = false, ready;
    while (Date.now() < deadline) {
      const candidate = readJson(cacheFile);
      if (candidate?.port === port && String(candidate.pid) === systemctl("show", unitName, "--property=MainPID", "--value")) {
        try {
          const response = await fetch(launchUrl(candidate, port), { redirect: "manual", signal: AbortSignal.timeout(2000) });
          if ([302, 303].includes(response.status)) { ready = candidate; break; }
          if (!refreshed) { refreshed = true; systemctl("restart", unitName); }
        } catch { /* Await the service's reconnect; no user operation is replayed. */ }
      }
      await delay(300);
    }
    if (!ready) throw new Error(`Cloud connection is not ready. Inspect: journalctl --user -u ${unitName}`);
    open(launchUrl(ready, port));
  } else {
    const probe = createServer();
    const requested = Number(values.port ?? 0);
    if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw new Error("Invalid local port");
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(requested, "127.0.0.1", resolve); });
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", `127.0.0.1:${port}:127.0.0.1:${cloud.webPort ?? 3080}`];
    if (cloud.port) args.push("-p", String(cloud.port));
    if (cloud.identity_file) args.push("-i", cloud.identity_file, "-o", "IdentitiesOnly=yes");
    if (cloud.known_hosts_file) args.push("-o", `UserKnownHostsFile="${cloud.known_hosts_file.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
    const command = [cloud.node ?? "node", join(cloud.base, "dsh-entry.mjs"), "--state", cloud.state ?? join(cloud.base, "dsh-state")];
    if (profile.machine) command.push("--machine", profile.machine);
    args.push(cloud.host, command.map(quote).join(" "));
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => { console.error("Cloud entry timed out; inspect the connection before retrying"); child.kill(); }, 300000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      const ready = JSON.parse(line);
      if (ready.type !== "ready") { console.error(ready.error); child.stdin.end(); process.exitCode = 1; return; }
      writeJson(cacheFile, { ...ready, pid: process.pid, port });
      open(launchUrl(ready, port));
    });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify({ workspace }) + "\n");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { child.stdin.end(); child.kill(signal); });
    child.on("error", (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
    child.on("exit", (code) => { clearTimeout(timer); lines.close(); if (readJson(cacheFile)?.pid === process.pid) unlinkSync(cacheFile); process.exitCode = code ?? 1; });
  }
}

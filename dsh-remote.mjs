#!/usr/bin/env node
/** Device Web entry. Model execution and session storage stay on VPS4. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readJson, writeJson } from "./state-json.mjs";
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
function progress(background) {
  const started = Date.now();
  console.error("正在连接云端 DSH…" + (background ? "按 Ctrl+C 停止等待，后台连接继续保持。" : "按 Ctrl+C 关闭本次连接。"));
  const timer = setInterval(() => console.error(`连接尚未就绪，已等待 ${Math.round((Date.now() - started) / 1000)} 秒…`), 10000);
  timer.unref();
  return { started, stop: () => clearInterval(timer) };
}

async function waitForEntry({ cacheFile, port, status, start, restart, url, diagnostic }) {
  const feedback = progress(true);
  const controller = new AbortController();
  let interrupted;
  const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const handler = () => { interrupted = signal; controller.abort(); };
    process.once(signal, handler);
    return [signal, handler];
  });
  try {
    start();
    let refreshed = false;
    // Connection-only entries skip tool bootstrap. The service keeps retrying
    // after this interactive wait, without making the user wait five minutes.
    while (Date.now() - feedback.started < 45000) {
      controller.signal.throwIfAborted();
      const candidate = readJson(cacheFile);
      const pid = Number(status());
      if (candidate?.port === port && candidate.pid === pid) {
        let response;
        try {
          response = await fetch(url(candidate), { redirect: "manual", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]) });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // The service reconnects. User work is never submitted here.
        }
        if (response) {
          if ([302, 303].includes(response.status)) return candidate;
          if (!refreshed) { refreshed = true; restart(); }
        }
      } else if (pid > 0 && !refreshed && Date.now() - feedback.started >= 5000) {
        // Older foreground entries shared this file and could remove it while
        // a healthy service remained alive. Give cold startup a grace period,
        // then refresh that service's own launch capability once.
        refreshed = true;
        restart();
      }
      await delay(300, undefined, { signal: controller.signal });
    }
    throw new Error("等待云端连接已超过 45 秒。后台会继续重连；网络恢复后，重新运行 dsh web --remote。\n连接诊断：" + diagnostic);
  } catch (error) {
    if (!interrupted) throw error;
    console.error("已停止等待。后台连接继续保持，稍后可重新运行 dsh web --remote。");
    process.exitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[interrupted];
  } finally {
    feedback.stop();
    for (const [signal, handler] of listeners) process.off(signal, handler);
  }
}

async function readEntry(child, onReady, { persistent = false, cacheFile } = {}) {
  const feedback = progress(false);
  const lines = createInterface({ input: child.stdout });
  let ready = false, failure, interrupted;
  const timer = setTimeout(() => { failure = new Error("云端入口等待超时。请检查连接后重新运行 dsh web --remote。"); child.kill(); }, 300000);
  const stopProgress = () => { clearTimeout(timer); feedback.stop(); };
  const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const handler = () => { interrupted = signal; stopProgress(); child.stdin.end(); child.kill(); };
    process.once(signal, handler);
    return [signal, handler];
  });
  lines.once("line", (line) => {
    if (interrupted) return;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "ready") throw new Error(entry.error || "云端入口返回了无效响应。");
      onReady(entry);
      ready = true;
      stopProgress();
      if (!persistent) child.stdin.end();
    } catch (error) { failure = error; stopProgress(); child.kill(); }
  });
  child.stdin.on("error", () => {});
  return new Promise((resolve, reject) => {
    child.on("error", (error) => { failure = error; stopProgress(); });
    child.on("close", (code) => {
      stopProgress(); lines.close();
      for (const [signal, handler] of listeners) process.off(signal, handler);
      if (cacheFile && readJson(cacheFile)?.pid === process.pid) unlinkSync(cacheFile);
      if (interrupted) {
        console.error(ready ? "本次 Web 连接已关闭；云端 Agent 与会话继续保留。" : "本次连接已取消，稍后可重新运行 dsh web --remote。");
        process.exitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[interrupted];
        resolve();
      } else if (failure) reject(failure);
      else if (!ready || code !== 0) reject(new Error(ready ? `Web 连接已断开（退出码 ${code ?? 1}），请重新运行 dsh web --remote。` : `云端连接未建立（退出码 ${code ?? 1}），请检查上方连接信息后重试。`));
      else resolve();
    });
  });
}

async function main() {
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
    } else if (!values["no-open"] && ["darwin", "win32"].includes(process.platform)) {
      const browser = process.platform === "darwin" ? spawn("open", [url], { stdio: "ignore", detached: true }) : spawn(profile.python, ["-c", "import sys,webbrowser;webbrowser.open(sys.argv[1])", url], { stdio: "ignore", detached: true, windowsHide: true });
      browser.on("error", () => {}); browser.unref();
    }
  }
  if (profile.localState) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./dsh-entry.mjs", import.meta.url)), "--state", profile.localState, "--machine", profile.machine ?? "cloud"], { stdio: ["pipe", "pipe", "inherit"] });
    const completion = readEntry(child, (ready) => open(launchUrl(ready, new URL(ready.url).port)));
    child.stdin.write(JSON.stringify({ workspace }) + "\n");
    await completion;
  } else {
    const cloud = profile.cloud;
    if (!cloud?.host || cloud.host.startsWith("-")) throw new Error("Configure the cloud SSH host");
    const cacheDir = join(homedir(), ".cache/remote-dsh"); mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const id = createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 16);
    const cacheFile = join(cacheDir, id + ".json");
    if (!values.foreground && profile.nativeJobs) {
      const name = "web-" + id;
      const port = Number(values.port ?? profile.localPort ?? 3081);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local port");
      const manager = (action) => {
        const result = spawnSync(profile.python, [join(fileURLToPath(new URL(".", import.meta.url)), "device_services.py"), action, "--name", name, "--node", process.execPath, "--entry", fileURLToPath(import.meta.url), "--profile", profileFile, "--port", String(port)], { encoding: "utf8", windowsHide: true });
        if (result.status !== 0) throw new Error(result.stderr?.trim() || "Background connection failed");
        return JSON.parse(result.stdout);
      };
      const ready = await waitForEntry({ cacheFile, port, status: () => manager("web-status").pid, start: () => manager("web-start"), restart: () => manager("web-restart"), url: (candidate) => launchUrl(candidate, port), diagnostic: join(homedir(), ".local/share/remote-dsh-device/jobs", name + ".log") });
      if (ready) open(launchUrl(ready, port));
    } else if (!values.foreground) {
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
      const start = () => {
        if (!existsSync(unitFile) || readFileSync(unitFile, "utf8") !== unit) {
          if (existsSync(unitFile) && !readFileSync(unitFile, "utf8").includes("# remote-dsh managed Web tunnel")) throw new Error("Unmanaged Web tunnel service already exists");
          writeFileSync(unitFile, unit, { mode: 0o600 });
          systemctl("daemon-reload"); systemctl("enable", unitName); systemctl("restart", unitName);
        } else systemctl("start", unitName);
      };
      const ready = await waitForEntry({ cacheFile, port, status: () => systemctl("show", unitName, "--property=MainPID", "--value"), start, restart: () => systemctl("restart", unitName), url: (candidate) => launchUrl(candidate, port), diagnostic: `journalctl --user -u ${unitName} -n 30` });
      if (ready) open(launchUrl(ready, port));
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
      const command = [cloud.node ?? "node", posix.join(cloud.base, "dsh-entry.mjs"), "--state", cloud.state ?? posix.join(cloud.base, "dsh-state")];
      if (profile.machine) command.push("--machine", profile.machine);
      args.push(cloud.host, command.map(quote).join(" "));
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
      // Only the persistent service owns the shared cache. An interactive
      // foreground connection must not replace or remove its entry.
      const entryCache = values["connection-only"] ? cacheFile : undefined;
      const completion = readEntry(child, (ready) => {
        if (entryCache) writeJson(entryCache, { ...ready, pid: process.pid, port });
        open(launchUrl(ready, port));
      }, { persistent: true, cacheFile: entryCache });
      child.stdin.write(JSON.stringify({ workspace }) + "\n");
      await completion;
    }
  }
}

try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }

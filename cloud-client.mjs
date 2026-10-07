/** Transport only: no local model, tool execution, or conversation writer. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

export class CloudClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.pending = new Map();
    this.state = null;
  }
  async connect() {
    if (this.output) throw new Error("Client is already connected");
    if (this.options.socket) {
      const socket = connect(this.options.socket);
      await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      this.transport = socket;
      this.output = socket;
      this.input = createInterface({ input: socket, crlfDelay: Infinity });
      socket.on("error", () => {});
      socket.once("close", () => this.disconnected(undefined, socket));
    } else {
      const cloud = this.options.cloud;
      if (!cloud?.host) throw new Error("Configure a cloud SSH host or a local socket");
      const base = cloud.base ?? ".local/share/remote-mcp-demo";
      const command = [cloud.node ?? "node", join(base, "cloud-bridge.mjs")];
      if (cloud.socket) command.push("--socket", cloud.socket);
      const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
      if (cloud.port) args.push("-p", String(cloud.port));
      if (cloud.identity_file) args.push("-i", cloud.identity_file, "-o", "IdentitiesOnly=yes");
      if (cloud.known_hosts_file) {
        const path = cloud.known_hosts_file.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        args.push("-o", `UserKnownHostsFile="${path}"`);
      }
      args.push(cloud.host, command.map(quote).join(" "));
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      this.transport = child;
      this.output = child.stdin;
      this.input = createInterface({ input: child.stdout, crlfDelay: Infinity });
      child.stderr.on("data", (data) => this.emit("diagnostic", data.toString()));
      child.stdin.on("error", () => {});
      child.once("error", (error) => this.disconnected(error, child));
      child.once("exit", (code) => this.disconnected(new Error(`SSH connection closed (${code})`), child));
    }
    const transport = this.transport;
    this.input.on("error", (error) => this.disconnected(error, transport));
    this.input.on("line", (line) => {
      if (transport !== this.transport || !this.output) return;
      let message;
      try { message = JSON.parse(line); } catch { this.disconnected(new Error("Invalid cloud response"), transport); return; }
      if (message.type === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      } else if (message.type === "event") {
        if (this.state && message.session === this.state.id) {
          if (message.sequence <= this.state.sequence) return;
          this.state.sequence = message.sequence;
          if (message.event.type === "session_state") {
            Object.assign(this.state, message.event);
            this.state.canInput = this.state.controller?.connection === this.connection;
          }
        }
        this.emit("event", message);
      }
    });
    const hello = await this.request("hello", {
      name: this.options.name, machine: this.options.machine, workspace: this.options.workspace,
      workspaceId: this.options.workspaceId,
    });
    this.connection = hello.connection;
    this.homeWorkspace = hello.workspace;
    return hello;
  }
  disconnected(error = new Error("Cloud connection closed"), transport = this.transport) {
    // SSH exit/socket close can arrive after /reconnect installs a new transport.
    if (transport !== this.transport || !this.output) return;
    this.output = null;
    this.input?.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
    if (this.state) this.state.canInput = false;
    this.emit("disconnect", error);
  }
  async request(command, args = {}) {
    if (!this.output) throw new Error("Terminal disconnected; reconnect and sync before sending commands");
    const id = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Cloud request timed out: ${command}. Inspect session state before retrying a mutation.`));
      }, this.options.timeout ?? 300000);
      this.pending.set(id, { resolve, reject, timeout });
      this.output.write(JSON.stringify({ id, command, ...args }) + "\n");
    });
    if (result?.messages && result?.id) this.state = result;
    return result;
  }
  mutate(command, args = {}) { return this.request(command, { epoch: this.state?.epoch, ...args }); }
  async waitTurn(turnId, timeout = 300000) {
    let listener, disconnect;
    const completed = new Promise((resolve, reject) => {
      listener = (message) => {
        if (message.session === this.state?.id && message.event.type === "turn_complete" && message.event.turnId === turnId) resolve(message.event);
      };
      disconnect = (error) => reject(error);
      this.on("event", listener);
      this.on("disconnect", disconnect);
    });
    completed.catch(() => {}); // A disconnect can precede the turn-status response.
    let timer;
    try {
      const current = await this.request("turn", { turnId });
      if (current.status !== "running") return current;
      return await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Task is still running in the cloud; resume to inspect it")), timeout); })]);
    } finally {
      clearTimeout(timer);
      this.off("event", listener);
      this.off("disconnect", disconnect);
    }
  }
  close() {
    this.output?.end();
    if (this.options.socket) this.transport?.destroy();
    else this.transport?.kill("SIGTERM");
    this.disconnected();
  }
}

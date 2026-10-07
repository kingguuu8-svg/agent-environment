#!/usr/bin/env node
/** SSH authenticates the terminal; the Unix socket belongs to the cloud user. */
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { socket: { type: "string" } } });
const socket = connect(resolve(values.socket ?? join(homedir(), ".local/share/remote-mcp-demo/cloud/service.sock")));
socket.once("connect", () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
socket.on("error", (error) => { console.error(`Cloud connection failed: ${error.message}`); process.exitCode = 1; });
socket.once("close", () => { process.stdin.unpipe(socket); process.stdin.pause(); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => socket.destroy());

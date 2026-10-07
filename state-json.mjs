/** Small launchers can read private state without loading the agent SDK. */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

export function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

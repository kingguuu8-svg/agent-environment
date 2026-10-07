/** Read-only UI filesystem operations. Model file tools remain upstream Pi tools. */
import { createReadStream } from "node:fs";
import { open, realpath, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const maxBytes = 8 * 1024 * 1024;
function integer(value, fallback, minimum, maximum) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid file read range");
  return value;
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function readWorkspaceFile(workspace, request, signal) {
  signal.throwIfAborted();
  const root = await realpath(workspace);
  const input = request.path ?? homedir();
  if (typeof input !== "string" || input.includes("\0")) throw new Error("Invalid filesystem path");
  const path = await realpath(resolve(root, input));
  if (!inside(root, path)) throw new Error("Path is outside the selected workspace");
  const info = await stat(path);
  const metadata = { absolutePath: path, version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`, bytes: info.size };
  if (request.op === "stat") return { ...metadata, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other" };
  if (request.op === "list") {
    if (!info.isDirectory()) throw new Error("Path is not a directory");
    const names = (await readdir(path)).sort();
    const entries = await Promise.all(names.slice(0, 2000).map(async (name) => {
      signal.throwIfAborted();
      try {
        const child = await realpath(resolve(path, name));
        if (!inside(root, child)) return { name, type: "other" };
        const item = await stat(child);
        return { name, type: item.isDirectory() ? "directory" : item.isFile() ? "file" : "other", ...(item.isFile() ? { size: item.size } : {}) };
      } catch { return { name, type: "other" }; }
    }));
    return { path: relative(root, path).split(sep).join("/"), absolutePath: path, home: homedir(), entries, truncated: names.length > entries.length, version: metadata.version };
  }
  if (!info.isFile()) throw new Error("Only regular files can be previewed");
  if (request.op === "bytes") {
    const offset = integer(request.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const length = integer(request.length, info.size || 1, 1, maxBytes);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, info.size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      signal.throwIfAborted();
      return { ...metadata, offset, base64: buffer.subarray(0, bytesRead).toString("base64"), eof: offset + bytesRead >= info.size };
    } finally { await handle.close(); }
  }
  if (request.op !== "text") throw new Error("Unknown filesystem operation");
  const offset = integer(request.offset, 1, 1, 1000000);
  const limit = integer(request.limit, 200, 1, 2000);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const stream = createReadStream(path, { signal });
  let scanned = 0, current = 1, tail = "", lines = [], eof = true;
  try {
    outer: for await (const chunk of stream) {
      scanned += chunk.length;
      if (scanned > maxBytes) throw new Error("Text preview exceeds the scan limit");
      tail += decoder.decode(chunk, { stream: true });
      if (tail.includes("\0")) throw new Error("Binary file cannot be previewed as text");
      let newline;
      while ((newline = tail.indexOf("\n")) >= 0) {
        const line = tail.slice(0, newline);
        tail = tail.slice(newline + 1);
        if (current++ < offset) continue;
        if (lines.length === limit) { eof = false; break outer; }
        lines.push(line);
      }
    }
    if (eof) {
      tail += decoder.decode();
      if (tail && current >= offset) {
        if (lines.length === limit) eof = false;
        else lines.push(tail);
      }
    }
    return { ...metadata, offset, text: lines.join("\n"), lines: lines.length, eof };
  } finally { stream.destroy(); }
}

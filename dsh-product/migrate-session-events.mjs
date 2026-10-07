/** Repair pre-release demo events without changing their payload, order or history. */
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { home: { type: "string" }, state: { type: "string" } } });
if (!values.home || !values.state) throw new Error("Provide --home and --state after stopping the Host");
if (existsSync(resolve(values.state) + ".lock")) throw new Error("Stop the remote Host before migrating its session events");
const types = new Set(["remote/workspace", "remote/controller"]);
const plans = [];
function mark(plaintext) {
  let count = 0;
  const rows = plaintext.toString("utf8").split("\n").map((line) => {
    if (!line) return line;
    const row = JSON.parse(line);
    if (types.has(row.type) && row.ignorable !== true) {
      row.ignorable = true; count++;
      return JSON.stringify(row);
    }
    return line;
  });
  return { bytes: Buffer.from(rows.join("\n")), count };
}
function scan(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { scan(path); continue; }
    if (!entry.isFile() || !["session.v4.jsonl", "session.v4.jsonl.zstd"].includes(entry.name)) continue;
    const original = readFileSync(path);
    let output, count = 0;
    if (entry.name.endsWith(".zstd")) {
      const frames = [];
      let offset = 0;
      while (offset < original.length) {
        // Node's one-shot decoder stops at the first frame. bytesWritten is
        // the consumed compressed range; retain unchanged frames byte for byte.
        const { buffer, engine } = zstdDecompressSync(original.subarray(offset), { info: true });
        const consumed = engine.bytesWritten;
        if (!Number.isSafeInteger(consumed) || consumed <= 0) throw new Error("Invalid session frame boundary");
        const next = mark(buffer); count += next.count;
        frames.push(next.count ? zstdCompressSync(next.bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }) : original.subarray(offset, offset + consumed));
        offset += consumed;
      }
      output = Buffer.concat(frames);
    } else {
      const next = mark(original); output = next.bytes; count = next.count;
    }
    if (count) plans.push({ path, original, output, count });
  }
}
scan(join(resolve(values.home), "sessions"));
let events = 0;
for (const plan of plans) {
  const id = randomUUID();
  writeFileSync(plan.path + ".before-remote-events-" + id, plan.original, { flag: "wx", mode: 0o600 });
  const temporary = plan.path + "." + id + ".tmp";
  writeFileSync(temporary, plan.output, { flag: "wx", mode: 0o600 });
  renameSync(temporary, plan.path);
  events += plan.count;
}
process.stdout.write(`Repaired ${events} plugin event envelopes in ${plans.length} sessions; originals retained beside each log\n`);

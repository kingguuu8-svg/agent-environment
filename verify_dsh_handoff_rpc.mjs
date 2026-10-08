/** Cancel the pinned native browser RPC against an isolated real Host. */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { runInNewContext } from "node:vm";

const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const source = await readFile(require.resolve("@deepseek-ai/dsh-client-connection/package.json").replace("package.json", "lib/client.js"), "utf8");
const anchor = "exports.apply = apply;";
assert.equal(source.split(anchor).length, 2);
let native;
runInNewContext(source.replace(anchor, `${anchor}\nexports.handoffRpc = createWebConnectionRpc;`), {
  window: { __ModuleLoader__: { load(definition) { native = definition.factory(require); } } },
  crypto: webcrypto, AbortController, AbortSignal, URL, TextEncoder, TextDecoder,
});
const lines = createInterface({ input: process.stdin });
const iterator = lines[Symbol.asyncIterator]();
const config = JSON.parse((await iterator.next()).value);
const rpc = native.handoffRpc((path, init) => fetch(new URL(path, config.origin + "/"), {
  ...init, headers: { ...init.headers, Cookie: config.cookie, Origin: config.origin },
}));
const abort = new AbortController();
const pending = rpc.call("/api", "remoteWorkspaces/switch", { args: { request: config.request } }, abort.signal)
  .then(() => ({ aborted: false }), (error) => {
    assert.equal(error.name, "AbortError", error.message);
    return { aborted: true };
  });
assert.equal((await iterator.next()).value, "cancel");
abort.abort();
assert.deepEqual(await pending, { aborted: true });
console.log("PASS native fetch cancellation");
lines.close();

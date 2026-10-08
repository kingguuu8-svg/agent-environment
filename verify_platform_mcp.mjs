/** An ordinary MCP client uses the standalone service without installing DSH. */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { url, account, key, target } = JSON.parse(input);
const client = new Client({ name: "independent-agent", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("mcp", url), {
    requestInit: { headers: { Authorization: "Basic " + Buffer.from(`${account}:${key}`).toString("base64") } },
  }));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["environment"]);
  const call = (args) => client.callTool({ name: "environment", arguments: args });
  const context = await call({ action: "context", target });
  assert.equal(context.isError, undefined);
  assert.equal(context.structuredContent.target.id, target);
  const read = await call({ action: "call", target, tool: "read", args: { path: "cross-device.txt" } });
  assert.equal(read.isError, undefined);
  assert(read.content.some((item) => item.type === "text" && item.text.includes("from-first-to-second")));
  assert(read._meta["remote/pi"]);
  const invalid = await call({ action: "call", target, tool: "missing", args: {} });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "unknown_tool");
  process.stdout.write("PASS independent MCP discovery, context, native tool result and structured error\n");
} finally {
  await client.close();
}

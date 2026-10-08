/** Actual HTTP failures, independent cancellation and recovery in the shared environment. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Environment } from "./environment.mjs";
import { createMcpService } from "./mcp_discovery_fixture.mjs";

const base = await mkdtemp(join(process.cwd(), ".local/mcp-discovery-"));
const services = {}, checks = [], timings = {};
let environment;
function passed(name) { checks.push(name); console.log("PASS " + name); }
async function waitFor(predicate) {
  const start = performance.now();
  while (!predicate()) { assert.ok(performance.now() - start < 5000, "Fixture request did not arrive"); await delay(20); }
}
async function call(id, message, waitMs = 0) {
  const descriptor = environment.descriptors(id)[0];
  return environment.definition(id, descriptor).execute("diagnostic", { message, waitMs });
}

try {
  for (const mode of ["ready", "initialize", "initialized", "list", "second-page", "unauthorized"]) services[mode] = await createMcpService(mode);
  const cloud = join(base, "cloud"), state = join(base, "state"), config = join(base, "targets.json");
  await mkdir(cloud); await mkdir(state);
  await writeFile(join(cloud, "proof.txt"), "CLOUD-STILL-WORKS\n");
  await writeFile(config, JSON.stringify({ targets: {}, mcp: Object.fromEntries(Object.entries(services).map(([id, service]) => [id.replaceAll("-", "_"), { url: service.url }])) }));
  environment = new Environment({ stateDir: state, config, cloudWorkspace: cloud });

  const alreadyCancelled = new AbortController(); alreadyCancelled.abort(new Error("already cancelled"));
  await assert.rejects(environment.discover(alreadyCancelled.signal), /already cancelled/);
  assert.ok(Object.values(services).every((service) => service.requests.length === 0));
  passed("pre-cancelled discovery starts no service requests");
  await assert.rejects(environment.connect("unknown"), /Unknown workspace or service/);
  passed("unknown service is rejected");

  const start = performance.now(), cancelled = new AbortController();
  const cancellation = assert.rejects(environment.discover(cancelled.signal), /caller cancelled/);
  const first = environment.discover(), second = environment.discover();
  await waitFor(() => environment.descriptors("ready").length === 2 && services.initialized.requests.some((request) => request.method === "notifications/initialized"));
  const cancellingAt = performance.now(); cancelled.abort(new Error("caller cancelled"));
  await cancellation;
  timings.cancellationSeconds = (performance.now() - cancellingAt) / 1000;
  assert.ok(timings.cancellationSeconds < 1);
  assert.ok(environment.connecting.has("initialized"));
  passed("cancelled caller returns promptly while another caller still shares initialization");

  const healthy = await call("ready", "healthy-during-discovery");
  assert.deepEqual(healthy.details.structuredContent, { accepted: true, message: "healthy-during-discovery" });
  const cloudResult = await environment.definition("cloud", environment.descriptors("cloud").find((tool) => tool.name === "read")).execute("cloud-proof", { path: "proof.txt" });
  assert.ok(cloudResult.content.some((item) => item.text?.includes("CLOUD-STILL-WORKS")));
  passed("healthy paginated schemas, structured results and native cloud tools work during a stalled discovery");

  const longStarted = performance.now();
  const longCall = call("ready", "long-call", 13000);
  const [listing, concurrentListing] = await Promise.all([first, second]);
  timings.discoverySeconds = (performance.now() - start) / 1000;
  assert.ok(timings.discoverySeconds >= 11.5 && timings.discoverySeconds < 15, JSON.stringify(timings));
  assert.deepEqual(listing, concurrentListing);
  for (const mode of ["initialize", "initialized", "list", "second-page"]) {
    const id = mode.replaceAll("-", "_");
    const target = listing.find((target) => target.id === id);
    assert.equal(target.availability, "unavailable");
    assert.match(target.error, /timed out after 12 seconds/);
    assert.deepEqual(target.tools, []);
    assert.equal(services[mode].requests.filter((request) => request.method === "initialize").length, 1);
    passed(mode + " failure is bounded, shares one attempt and publishes no incomplete tools");
  }
  assert.ok(services["second-page"].requests.some((request) => request.cursor === "second-page"));
  assert.match(listing.find((target) => target.id === "unauthorized").error, /403|denied/);
  assert.equal(listing.find((target) => target.id === "unauthorized").availability, "unavailable");
  passed("denied service does not block authorized services");
  assert.deepEqual((await longCall).details.structuredContent, { accepted: true, message: "long-call" });
  timings.longCallSeconds = (performance.now() - longStarted) / 1000;
  assert.ok(timings.longCallSeconds >= 13);
  await call("ready", "after-deadline");
  passed("completed discovery clears its deadline and preserves longer real tool calls");

  for (const mode of ["initialize", "initialized", "list", "second-page"]) { services[mode].setMode("ready"); services[mode].replaceTools(); }
  const recovered = await environment.discover();
  for (const mode of ["initialize", "initialized", "list", "second-page"]) {
    const id = mode.replaceAll("-", "_");
    assert.equal(recovered.find((target) => target.id === id).availability, "connected");
    assert.deepEqual(environment.descriptors(id), services[mode].tools);
    assert.equal(environment.get(id).lastError, undefined);
    await call(id, "recovered");
  }
  passed("same registered identities recover with fresh complete schemas and successful actual calls");

  const cached = structuredClone(environment.descriptors("ready")), version = environment.version;
  await environment.disconnect("ready");
  services.ready.replaceTools(); services.ready.setMode("second-page");
  const retryStarted = performance.now(), retry = environment.discover();
  await waitFor(() => services.ready.requests.filter((request) => request.cursor === "second-page").length === 2);
  assert.deepEqual(environment.descriptors("ready"), cached);
  await call("initialized", "other-service-during-retry");
  const retryResult = await retry;
  timings.retrySeconds = (performance.now() - retryStarted) / 1000;
  assert.equal(retryResult.find((target) => target.id === "ready").availability, "unavailable");
  assert.deepEqual(environment.descriptors("ready"), cached);
  assert.equal(environment.version, version);
  const persisted = JSON.parse(await readFile(join(state, "environment.json"), "utf8"));
  assert.deepEqual(persisted.ready.descriptors, cached);
  passed("failed rediscovery keeps prior schemas and version while other services remain callable");

  services.ready.setMode("ready");
  await environment.discover();
  assert.deepEqual(environment.descriptors("ready"), services.ready.tools);
  assert.equal(environment.version, version + 1);
  await call("ready", "fresh-schema");
  assert.equal(environment.entries.size, 7);
  passed("recovery atomically replaces cached schemas without duplicating service identities");
  await environment.close();
  assert.equal(environment.connections.size, 0);
  assert.equal(environment.connecting.size, 0);
  passed("all shared initialization and tool transports finish cleanly");
  await writeFile(".local/verification-mcp-discovery.json", JSON.stringify({ checks, timings }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ checks: checks.length, timings }));
} finally {
  await environment?.close();
  await Promise.allSettled(Object.values(services).map((service) => service.close()));
  await rm(base, { recursive: true, force: true });
}

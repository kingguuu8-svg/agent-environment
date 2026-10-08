/** Exercise model sync with native YAML and disposable credentials, without models. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyLocalModels, modelPatches, readLocalModels } from "./dsh-product/model-config.mjs";

const { parse, stringify } = createRequire(new URL("./dsh-product/model-config.mjs", import.meta.url))("yaml");
mkdirSync(".local", { recursive: true });
const root = resolve(mkdtempSync(".local/dsh-models-"));
const home = join(root, "local"), runtime = join(root, "runtime");
const localProfile = join(home, "profiles/desktop"), remoteProfile = join(runtime, "dsh-home/profiles/remote-web");
for (const path of [localProfile, remoteProfile]) mkdirSync(path, { recursive: true });
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const checks = [];
const passed = (name) => { checks.push(name); process.stdout.write(`PASS ${name}\n`); };
const selection = { provider: "responses", model: "gpt-6.1-sol", reasoningEffort: "high" };
const providers = {
  responses: { api: "openai-responses", apiKeyEnv: "FIRST_MODEL_KEY", baseURL: "https://example.invalid/v1", models: [{ id: "gpt-6.1-sol", name: "Custom model name", input: ["text", "image"], contextWindow: 372000, maxTokens: 32768, reasoningEfforts: { low: "low", high: "high" } }] },
  completions: { api: "openai-completions", apiKeyEnv: "SECOND_MODEL_KEY", baseURL: "https://example.invalid/v1", models: [{ id: "glm-5.3-flash", name: "GLM" }] },
};
const old = { providers: { legacy: { api: "openai-completions", baseUrl: "https://old.invalid/v1", apiKey: "$LEGACY_MODEL_KEY", models: [{ id: "previous-model" }] } } };
const creds = join(home, ".credentials.yaml");
save(creds, { version: 1, refs: { FIRST_MODEL_KEY: "first-fixture", SECOND_MODEL_KEY: "second-fixture", DEEPSEEK_API_KEY: "deepseek-fixture", UNRELATED_KEY: "do-not-transfer" }, records: { untouched: { data: "do-not-transfer" } } });
save(join(localProfile, "cordis.patch.yml"), [{ insert: [
  { id: "agent-default-model", config: selection },
  { id: "llm-pi-ai", config: { providers } },
  { id: "llm-deepseek", config: { models: [{ id: "deepseek-flash", inputModalities: ["text", "image"] }] } },
  { id: "unrelated-plugin", config: { setting: true } },
] }]);
save(join(runtime, "dsh-models.json"), old);
const patchPath = join(remoteProfile, "cordis.patch.yml");
writeFileSync(patchPath, "# Existing remote controls\n" + stringify([{ id: "agent-default-model", config: { provider: "legacy", model: "previous-model" } }, { id: "llm-pi-ai", config: {} }, { id: "hmr", disabled: true }, { insert: [{ id: "remote-workspaces", config: { stateDir: "unchanged" } }] }]), { mode: 0o600 });
const remoteCreds = join(runtime, "dsh-home/.credentials.yaml");
save(remoteCreds, { version: 1, refs: { CLOUD_ONLY: "keep", LEGACY_MODEL_KEY: "legacy-fixture" }, records: { "llm-pi-ai/test": { type: "api_key", key: "keep-record" } } });

try {
  const legacy = modelPatches(old);
  assert.equal(legacy[1].config.providers.legacy.apiKeyEnv, "LEGACY_MODEL_KEY");
  assert.equal(legacy[0].config.model, "previous-model");
  const multiple = modelPatches({ providers: { ...old.providers, second: { ...old.providers.legacy, models: [{ id: "second-model" }] } } });
  assert.deepEqual(Object.keys(multiple[1].config.providers), ["legacy", "second"]);
  passed("existing Pi configuration remains compatible and all legacy providers are preserved");

  const local = readLocalModels(home, "desktop", { FIRST_MODEL_KEY: "environment-wins" });
  assert.deepEqual(local.dsh.piAI.providers, providers);
  assert.deepEqual(local.dsh.defaultSelection, selection);
  assert.deepEqual(Object.keys(local.refs), ["FIRST_MODEL_KEY", "SECOND_MODEL_KEY", "DEEPSEEK_API_KEY"]);
  assert.equal(local.refs.FIRST_MODEL_KEY, "environment-wins");
  assert(!JSON.stringify(local).includes("do-not-transfer"));
  passed("local model names, protocols, vision, reasoning and default are copied with only referenced credentials");

  assert.throws(() => readLocalModels(home, "../escape", {}), /Invalid local profile/);
  chmodSync(creds, 0o644);
  assert.throws(() => readLocalModels(home, "desktop", {}), /private/);
  chmodSync(creds, 0o600);
  const credentialBackup = readFileSync(creds);
  save(creds, { version: 1, refs: {} });
  assert.throws(() => readLocalModels(home, "desktop", {}), /Missing local model credential/);
  writeFileSync(creds, credentialBackup);
  passed("invalid profiles, readable credentials and missing model keys are rejected before deployment");

  const previous = parse(readFileSync(patchPath, "utf8"));
  const report = applyLocalModels(runtime, local);
  assert.equal(report.modelCount, 3);
  const changed = parse(readFileSync(patchPath, "utf8"));
  for (const id of ["hmr", "remote-workspaces"]) {
    const find = (list) => list.flatMap((item) => item.insert ?? [item]).find((item) => item.id === id);
    assert.deepEqual(find(changed), find(previous));
  }
  assert(readFileSync(patchPath, "utf8").startsWith("# Existing remote controls"));
  const modelData = JSON.parse(readFileSync(join(runtime, "dsh-models.json")));
  assert.deepEqual(modelData.providers, old.providers);
  assert.deepEqual(modelData.dsh, local.dsh);
  const pi = changed.find((item) => item.id === "llm-pi-ai").config;
  assert.deepEqual(Object.keys(pi.providers), ["legacy", "responses", "completions"]);
  assert.deepEqual(pi.providers.responses, providers.responses);
  passed("applying a sync preserves old model routes, unrelated profile entries, comments and capabilities");

  const transferred = parse(readFileSync(remoteCreds, "utf8"));
  assert.equal(transferred.refs.CLOUD_ONLY, "keep");
  assert.equal(transferred.refs.LEGACY_MODEL_KEY, "legacy-fixture");
  assert.equal(transferred.refs.FIRST_MODEL_KEY, "environment-wins");
  assert.equal(transferred.records["llm-pi-ai/test"].key, "keep-record");
  assert(!Object.hasOwn(transferred.refs, "UNRELATED_KEY"));
  for (const path of [patchPath, remoteCreds, join(runtime, "dsh-models.json")]) assert.equal(statSync(path).mode & 0o777, 0o600);
  passed("native credential references merge privately while other keys and account records remain intact");

  const once = readFileSync(patchPath, "utf8");
  applyLocalModels(runtime, local);
  assert.equal(readFileSync(patchPath, "utf8"), once);
  assert.deepEqual(modelPatches(modelData), changed.filter((item) => ["agent-default-model", "llm-pi-ai", "llm-deepseek"].includes(item.id)));
  rmSync(remoteCreds);
  applyLocalModels(runtime, local);
  assert(existsSync(remoteCreds));
  assert.equal(parse(readFileSync(remoteCreds, "utf8")).version, 1);
  passed("repeated synchronization is idempotent, fresh hosts get native credentials and profile recreation keeps the synchronized models");
  writeFileSync(".local/verification-dsh-model-config.json", JSON.stringify({ checks }, null, 2) + "\n", { mode: 0o600 });
} finally {
  rmSync(root, { recursive: true, force: true });
}

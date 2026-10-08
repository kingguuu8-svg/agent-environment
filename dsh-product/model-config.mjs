/** Model-only configuration shared by profile creation and local-to-cloud sync. */
import { createRequire } from "node:module";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { parseDocument } = createRequire(import.meta.url)("yaml");
const readDocument = (path) => {
  const document = parseDocument(readFileSync(path, "utf8"), { logLevel: "silent" });
  if (document.errors.length) throw new Error(`Cannot parse configuration: ${path}`);
  return document;
};
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));

export function modelPatches(models) {
  const providers = Object.fromEntries(Object.entries(models.providers ?? {}).map(([id, item]) => [id, {
    apiKeyEnv: item.apiKeyEnv ?? item.apiKey?.match(/^\$([A-Z_][A-Z0-9_]*)$/)?.[1] ?? "REMOTE_MCP_CHECK_API_KEY",
    api: item.api, baseURL: item.baseUrl,
    models: item.models.map((model) => ({ ...model, name: model.name ?? model.id })),
    retryPolicy: { mode: "normal", maxRetries: 1 },
  }]));
  Object.assign(providers, models.dsh?.piAI?.providers);
  const [provider, first] = Object.entries(providers)[0] ?? [];
  const selection = models.dsh?.defaultSelection ?? (first && { provider, model: first.models[0].id });
  if (!selection) throw new Error("No default model is configured");
  return [
    { id: "agent-default-model", config: selection },
    { id: "llm-pi-ai", config: { ...models.dsh?.piAI, providers } },
    ...(models.dsh?.deepseek ? [{ id: "llm-deepseek", config: models.dsh.deepseek }] : []),
  ];
}

export function readLocalModels(home, profile, environment = process.env) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error("Invalid local profile name");
  const patches = readDocument(join(home, "profiles", profile, "cordis.patch.yml")).toJS();
  const entries = [];
  const collect = (items) => {
    for (const item of items ?? []) {
      if (item.disabled === true) continue;
      if (item.id) entries.push(item);
      if (item.insert) collect(item.insert);
      if (item.group && Array.isArray(item.config)) collect(item.config);
    }
  };
  collect(patches);
  const configured = (id) => entries.filter((item) => item.id === id).at(-1)?.config;
  const piAI = structuredClone(configured("llm-pi-ai"));
  const deepseek = structuredClone(configured("llm-deepseek"));
  const defaultSelection = structuredClone(configured("agent-default-model"));
  if (!piAI?.providers || !defaultSelection) throw new Error("Local profile must declare its model providers and default selection");
  if (deepseek && !deepseek.baseURL && environment.DEEPSEEK_BASE_URL) deepseek.baseURL = environment.DEEPSEEK_BASE_URL;
  const credentialPath = join(home, ".credentials.yaml");
  if (process.platform !== "win32" && statSync(credentialPath).mode & 0o077) throw new Error("Local credentials must be private (mode 600)");
  const credentials = readDocument(credentialPath).toJS();
  const stored = credentials.version === 1 ? credentials.refs ?? {} : credentials;
  const names = new Set(Object.values(piAI.providers).map((provider) => provider.apiKeyEnv).filter(Boolean));
  if (deepseek) names.add(deepseek.apiKeyEnv ?? "DEEPSEEK_API_KEY");
  const refs = {};
  for (const name of names) {
    const value = environment[name] || stored[name];
    if (typeof value !== "string" || !value) throw new Error(`Missing local model credential: ${name}`);
    refs[name] = value;
  }
  return { dsh: { piAI, ...(deepseek ? { deepseek } : {}), defaultSelection }, refs };
}

export function applyLocalModels(runtime, local) {
  const modelsPath = join(runtime, "dsh-models.json");
  const patchPath = join(runtime, "dsh-home/profiles/remote-web/cordis.patch.yml");
  const credentialPath = join(runtime, "dsh-home/.credentials.yaml");
  const models = { ...readJSON(modelsPath), dsh: local.dsh };
  const document = readDocument(patchPath);
  const patches = document.toJS();
  for (const patch of modelPatches(models)) {
    const index = patches.findIndex((item) => item.id === patch.id);
    if (index < 0) document.add(patch);
    else document.setIn([index, "config"], patch.config);
  }
  const credentials = existsSync(credentialPath) ? readDocument(credentialPath) : parseDocument("version: 1\nrefs: {}\n");
  const credentialData = credentials.toJS();
  if (credentialData.version !== 1) throw new Error("Remote credentials must use the native version-1 layout");
  for (const [name, value] of Object.entries(local.refs)) credentials.setIn(["refs", name], value);
  const writes = [[modelsPath, JSON.stringify(models, null, 2) + "\n"], [patchPath, document.toString()], [credentialPath, credentials.toString()]];
  for (const [path, content] of writes) {
    const temporary = `${path}.${randomUUID()}.new`;
    writeFileSync(temporary, content, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }
  return { providers: Object.keys(local.dsh.piAI.providers), modelCount: Object.values(local.dsh.piAI.providers).reduce((sum, provider) => sum + provider.models.length, 0) + (local.dsh.deepseek?.models?.length ?? 0), default: local.dsh.defaultSelection, credentialCount: Object.keys(local.refs).length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { home: { type: "string" }, profile: { type: "string", default: "desktop" }, runtime: { type: "string" } } });
  if (values.runtime) {
    let input = "";
    for await (const part of process.stdin) input += part;
    process.stdout.write(JSON.stringify(applyLocalModels(resolve(values.runtime), JSON.parse(input))));
  } else {
    if (!values.home) throw new Error("Missing --home");
    // The sync command captures this private payload and sends it over SSH stdin.
    process.stdout.write(JSON.stringify(readLocalModels(resolve(values.home), values.profile)));
  }
}

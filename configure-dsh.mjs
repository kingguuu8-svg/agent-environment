/** Compose an isolated, pinned DSH Web profile without changing the user's DSH home. */
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
const { values } = parseArgs({ options: {
  home: { type: "string" }, targets: { type: "string" }, python: { type: "string" },
  state: { type: "string" }, workspace: { type: "string" }, model: { type: "string" },
} });
for (const option of ["home", "targets", "python", "state", "workspace", "model"]) if (!values[option]) throw new Error(`Missing --${option}`);
const root = fileURLToPath(new URL(".", import.meta.url));
const home = resolve(values.home), profile = join(home, "profiles/remote-web");
mkdirSync(profile, { recursive: true, mode: 0o700 });
const save = (name, value) => { const path = join(profile, name); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); chmodSync(path, 0o600); };
save("package.json", { name: "remote-dsh-profile", private: true, type: "module", dependencies: { "remote-dsh-workspaces": "0.1.0" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } });
const modules = join(root, "dsh-product/node_modules"), profileModules = join(profile, "node_modules");
try {
  if (!lstatSync(profileModules).isSymbolicLink()) throw new Error("Managed profile node_modules must be a symlink");
  if (readlinkSync(profileModules) !== modules) { unlinkSync(profileModules); symlinkSync(modules, profileModules, "dir"); }
} catch (error) { if (error.code === "ENOENT") symlinkSync(modules, profileModules, "dir"); else throw error; }
const modelConfig = JSON.parse(readFileSync(resolve(values.model), "utf8"));
const [provider, model] = Object.entries(modelConfig.providers)[0];
const patches = [
  { id: "hmr", disabled: true },
  { id: "agent-default-model", config: { provider, model: model.models[0].id } },
  { id: "llm-pi-ai", config: { providers: { [provider]: { apiKeyEnv: "REMOTE_MCP_CHECK_API_KEY", api: model.api, baseURL: model.baseUrl, models: model.models.map((item) => ({ ...item, name: item.id })), retryPolicy: { mode: "normal", maxRetries: 1 } } } } },
  { id: "session-title-llm", disabled: true },
  { id: "preset-standard", disabled: true },
  { id: "preset-minimal", disabled: true },
  { id: "preset-cordis", disabled: true },
  { id: "preset-ptc", disabled: true },
  { id: "agent-preset-registry", config: { default: "remote" } },
  { id: "ui-open-in-app", disabled: true },
  { id: "workspace-changes", disabled: true },
  { id: "ui-deliverables", disabled: true },
  { id: "ui-sidebar-terminal", disabled: true },
  // Pi MCP tools run with the target OS user's permissions. The native local
  // sandbox selector would promise a boundary these tools do not implement.
  { id: "ui-permission", disabled: true },
  { insert: [
    { id: "preset-remote", name: "@deepseek-ai/dsh-agent-preset", config: { id: "remote", name: "多机器工作区", order: 0, plugins: [
      { id: "persona", name: "@deepseek-ai/dsh-persona", config: { prefix: "You are a helpful coding agent operating in a shared multi-machine environment. Use the current execution binding and project instructions provided below. Act on the user's task and verify your work.", includeRuntimeContext: false } },
      { id: "compaction", name: "cordis:group", group: true, isolate: { compaction: true, toolResultPruner: true }, config: [
        { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
        { id: "tool-result-pruner", name: "@deepseek-ai/dsh-compaction-tool-result-pruner", config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
      ] },
    ] } },
    { id: "remote-workspaces", name: "remote-dsh-workspaces", config: { stateDir: resolve(values.state), targets: resolve(values.targets), python: resolve(values.python), cloudWorkspace: resolve(values.workspace) } },
  ] },
];
save("cordis.patch.yml", patches);
process.stdout.write("DSH remote-web profile configured\n");

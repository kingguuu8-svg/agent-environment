/** Pin and check the small upstream integration required by DSH's immutable cwd. */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { remoteConversationStore } from "./remote-drafts.mjs";
const require = createRequire(import.meta.url);
const packageName = "@deepseek-ai/dsh-client-ui-sidebar-files";
const manifestPath = require.resolve(`${packageName}/package.json`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.version !== "0.2.0-rc.2") throw new Error("Revalidate DSH file-browser integration before upgrading");
const path = join(dirname(manifestPath), "lib/client.js");
let source = readFileSync(path, "utf8");
const marker = "// remote-dsh-workspaces: use the execution binding as the file tree root.";
if (!source.includes(marker)) {
  for (const [before, after] of [
    ["function FilesBody({ useTabInfo, sessionId, useSessions, useStore,", "function FilesBody({ useTabInfo, sessionId, useSessions, useProjection, useStore,"],
    ["const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);", `${marker}\n\t\t\tconst originalCwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);\n\t\t\tconst binding = useProjection(\"remoteBinding\");\n\t\t\tconst cwd = binding?.current?.workspace ?? originalCwd;`],
  ]) {
    if (source.split(before).length !== 2) throw new Error(`DSH integration anchor changed: ${before}`);
    source = source.replace(before, after);
  }
  writeFileSync(path, source);
}
process.stdout.write("DSH file-browser binding integration ready\n");
const conversationManifestPath = require.resolve("@deepseek-ai/dsh-client-ui-conversation/package.json");
if (JSON.parse(readFileSync(conversationManifestPath, "utf8")).version !== "0.2.0-rc.2") throw new Error("Revalidate DSH composer integration before upgrading");
const conversationPath = join(dirname(conversationManifestPath), "lib/client.js");
let conversation = readFileSync(conversationPath, "utf8");
const controlMarker = "// remote-dsh-workspaces: fence the composer to its input controller.";
if (!conversation.includes(controlMarker)) {
  const before = "variant, disabled: inert = false, blocked, workspacePickerOpen";
  if (conversation.split(before).length !== 2) throw new Error("DSH composer integration anchor changed");
  conversation = conversation.replace(before, "variant, disabled: suppliedInert = false, blocked, workspacePickerOpen");
  const insertion = "const planActive = useProjection(\"plan\", (plan) => plan !== void 0 && (plan.pending ? !plan.active : plan.active));";
  if (conversation.split(insertion).length !== 2) throw new Error("DSH composer projection anchor changed");
  conversation = conversation.replace(insertion, `${controlMarker}\n\t\t\tconst remoteController = useProjection(\"remoteController\");\n\t\t\tconst inert = suppliedInert || (remoteController != null && remoteController.clientId !== document.documentElement.dataset.remoteDshClient);\n\t\t\t${insertion}`);
  writeFileSync(conversationPath, conversation);
}
const viewerMarker = "// remote-dsh-workspaces: explain the read-only viewer state.";
if (!conversation.includes(viewerMarker)) {
  const controlAnchor = 'const inert = suppliedInert || (remoteController != null && remoteController.clientId !== document.documentElement.dataset.remoteDshClient);';
  const placeholderAnchor = "const placeholderText = placeholder ??";
  if (conversation.split(controlAnchor).length !== 2 || conversation.split(placeholderAnchor).length !== 2) throw new Error("DSH viewer placeholder integration anchor changed");
  conversation = conversation.replace(controlAnchor, `${viewerMarker}\n\t\t\tconst remoteViewer = remoteController != null && remoteController.clientId !== document.documentElement.dataset.remoteDshClient;\n\t\t\tconst inert = suppliedInert || remoteViewer;`);
  conversation = conversation.replace(placeholderAnchor, 'const placeholderText = remoteViewer ? "查看模式，请在顶部接管输入" : placeholder ??');
  writeFileSync(conversationPath, conversation);
}
process.stdout.write("DSH input-controller integration ready\n");
const draftMarker = "// remote-dsh-workspaces: preserve each window's unsent conversation draft.";
if (!conversation.includes(draftMarker)) {
  const definition = 'const CONVERSATION_STORE_KEY = "dsh.conversation";';
  const factoryStart = "function createConversationStore() {\n\t\t\treturn (0, _deepseek_ai_dsh_client_store.defineStore)({";
  const factoryEnd = "\n\t\t\t});\n\t\t}\n\t\t/**\n\t\t* Read the persisted View preference";
  const applyAnchor = "const conversationStore = createConversationStore();";
  for (const anchor of [definition, factoryStart, factoryEnd, applyAnchor]) {
    if (conversation.split(anchor).length !== 2) throw new Error("DSH draft persistence integration anchor changed");
  }
  conversation = conversation.replace(definition, `${definition}\n\t\t${draftMarker}\n\t\t${remoteConversationStore.toString()}`);
  conversation = conversation.replace(factoryStart, "function createConversationStore(sessions) {\n\t\t\treturn remoteConversationStore(_deepseek_ai_dsh_client_store.defineStore, {");
  conversation = conversation.replace(factoryEnd, "\n\t\t\t}, sessions);\n\t\t}\n\t\t/**\n\t\t* Read the persisted View preference");
  conversation = conversation.replace(applyAnchor, "const conversationStore = createConversationStore(ctx.sessions);");
  writeFileSync(conversationPath, conversation);
}
process.stdout.write("DSH window draft persistence integration ready\n");
const sessionManifestPath = require.resolve("@deepseek-ai/dsh-session/package.json");
if (JSON.parse(readFileSync(sessionManifestPath, "utf8")).version !== "0.2.0-rc.2") throw new Error("Revalidate DSH plugin-event integration before upgrading");
const sessionPath = join(dirname(sessionManifestPath), "lib/index.js");
let session = readFileSync(sessionPath, "utf8");
const eventMarker = "// remote-dsh-workspaces: preserve external log-only event compatibility.";
if (!session.includes(eventMarker)) {
  const anchor = "const surfaceMetadata = {\n\t\t\t...surfaceOpts?.sourceEventSeqs";
  if (session.split(anchor).length !== 2) throw new Error("DSH event-envelope integration anchor changed");
  session = session.replace(anchor, `const surfaceMetadata = {\n\t\t\t${eventMarker}\n\t\t\t...surfaceOpts?.ignorable === true ? { ignorable: true } : {},\n\t\t\t...surfaceOpts?.sourceEventSeqs`);
  writeFileSync(sessionPath, session);
}
process.stdout.write("DSH external session-event integration ready\n");

/** Expose the pinned frontend's existing public Markdown context hook to plugins. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const asset = new URL("./node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js", import.meta.url);
const originalHash = "af3ff948cf3f132edbddebea93e2f9f02233b390a94bd4c9842182300be811bb";
const originalExport = "MarkdownDelegateProvider:jb,";
const patchedExport = originalExport + "useMarkdownDelegate:Bc,";
const digest = (text) => createHash("sha256").update(text).digest("hex");

export function exposeMarkdownDelegate(source) {
  const original = source.replace(patchedExport, originalExport);
  if (digest(original) !== originalHash) throw new Error("Unsupported DSH frontend build for Markdown context exports");
  return original.replace(originalExport, patchedExport);
}

export function ensureFrontendExports() {
  const source = readFileSync(asset, "utf8");
  const patched = exposeMarkdownDelegate(source);
  if (source !== patched) writeFileSync(asset, patched);
}

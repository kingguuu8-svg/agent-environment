/** Exercise the pinned native assistant and Markdown links inside the real plugin slot. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { exposeMarkdownDelegate } from "./dsh-product/frontend-exports.mjs";

const require = createRequire(new URL("./dsh-product/package.json", import.meta.url));
const React = require("react");
const { act, create } = require("react-test-renderer");
const { SlotCore } = await import(require.resolve("@deepseek-ai/dsh-client-ui-slots"));
const { createSnapshotStore } = await import(require.resolve("@deepseek-ai/dsh-client-store"));
const clientSource = await readFile(new URL("./dsh-product/plugin/client.js", import.meta.url), "utf8");
const report = JSON.parse(await readFile(new URL("./.local/verification-dsh-replies.json", import.meta.url), "utf8"));
const document = { baseURI: "http://127.0.0.1:1/", documentElement: { dataset: {} },
  querySelector: () => null, createElement: () => ({ dataset: {}, remove() {} }), head: { append() {}, appendChild() {} } };

// Feed controlled Markdown tokens to the actual native link renderer in Node.
// Full Markdown parsing is checked separately in the real browser; this test
// exercises the native context, path decoder and assistant without CSS or DOM.
const primitivesSource = await readFile(require.resolve("@deepseek-ai/dsh-client-ui-primitives"), "utf8");
const region = (start, end) => {
  assert.equal(primitivesSource.split(start).length, 2);
  assert.equal(primitivesSource.split(end).length, 2);
  return primitivesSource.slice(primitivesSource.indexOf(start), primitivesSource.indexOf(end));
};
const primitiveExports = {};
runInNewContext([
  region("//#region lib/types/markdown/file-link.js", "//#region lib/types/markdown/katex.js"),
  region("//#region lib/types/markdown/MarkdownDelegate.js", "//#region lib/types/ImageLightbox.js"),
  region("//#region lib/types/markdown/render.js", "//#region lib/types/markdown/MarkdownText.js"),
  "exports.primitives = { MarkdownDelegateProvider, useMarkdownDelegate, renderAnchor, renderNode, MarkdownImage };",
].join("\n"), { ...React, ...require("react/jsx-runtime"), Fragment$1: React.Fragment,
  exports: primitiveExports, URL, document, markdownCss: {},
  LinkIconMedium: () => null, classifyLinkPath: () => "other", clsx: () => "", normalizeUri: (value) => value,
});
const primitives = primitiveExports.primitives;
assert.equal(typeof primitives.useMarkdownDelegate, "function");
primitives.MarkdownText = ({ text, streaming, fileMentions }) => {
  const nodes = [...text.matchAll(/(!?)\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`/g)].map((match, key) => match[4] ?
    primitives.renderNode({ type: "inlineCode", value: match[4] }, key, { fileMentions: streaming ? undefined : fileMentions }) : match[1] ?
      React.createElement(primitives.MarkdownImage, { destination: match[3], alt: match[2], streaming, key }) :
      primitives.renderAnchor(match[3], match[2], key, false, streaming));
  return React.createElement("section", null, nodes);
};

const nativeSource = await readFile(require.resolve("@deepseek-ai/dsh-client-ui-chat/package.json").replace("package.json", "lib/client.js"), "utf8");
const anchor = "exports.apply = apply;";
assert.equal(nativeSource.split(anchor).length, 2);
let NativeAssistant;
runInNewContext(nativeSource.replace(anchor, `${anchor}\nexports.test = { AssistantNodeView };`), {
  window: { __ModuleLoader__: { load(definition) {
    NativeAssistant = definition.factory((name) => {
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return new Proxy(primitives, { get: (target, key) => target[key] ?? (() => null) });
      if (name === "react-dom") return {};
      return require(name);
    }).test.AssistantNodeView;
  } } }, document, TextEncoder, TextDecoder, URL,
});
const frontendSource = await readFile(require.resolve("@deepseek-ai/dsh-web-frontend/package.json").replace("package.json", "dist/assets/index-5SrrfWpU.js"), "utf8");
const patched = exposeMarkdownDelegate(frontendSource);
assert.equal(exposeMarkdownDelegate(patched), patched);
assert.ok(patched.includes("MarkdownDelegateProvider:jb,useMarkdownDelegate:Bc,"));
assert.ok(patched.includes("function Bc(){return j.useContext(b8)}"));
assert.throws(() => exposeMarkdownDelegate(frontendSource + "\n"), /Unsupported DSH frontend/);
let checks = 0;
const passed = (name) => { checks++; console.log("PASS " + name); };
passed("the pinned browser build exposes its existing context reader idempotently and rejects a different build");

const sessionId = "session-reply-owner", selection = createSnapshotStore({ sessionId });
const presentation = createSnapshotStore({});
const injected = { hooks: { presentation } };
const slots = new SlotCore(), cleanup = [];
const disposeFactory = slots.registerFactory({ name: "test-chat", scope: "root", children: {
  "conversation.chat.node": { kind: "keyed", scope: "session" },
} }, () => null);
let disposeNative;
const registerNative = () => { disposeNative = slots.register({ name: "conversation.chat.node", key: "assistant-step", locale: "native-chat", inject: () => injected }, NativeAssistant); };
let plugin, resolveReply, rejectReply;
const opened = [], requests = [], external = [], images = [];
runInNewContext(clientSource, {
  window: { __ModuleLoader__: { load(definition) { plugin = definition.factory((name) => name === "react" ? React : primitives); } } },
  document, sessionStorage: { getItem: () => null, setItem() {} }, performance: { getEntriesByType: () => [] },
  location: { hash: "", search: "", href: "http://127.0.0.1:1" }, URL, URLSearchParams, crypto: { randomUUID },
  setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
});
plugin.apply({
  slots: { register: slots.register.bind(slots), entriesOfSlot: slots.entriesOfSlot.bind(slots), subscribe: slots.subscribe.bind(slots),
    inject(name, register) { if (name === "conversation.chat.node") cleanup.push(register()); } },
  connection: { rpc: { call(channel, endpoint, payload) {
    assert.equal(channel, "/api"); assert.equal(endpoint, "remoteWorkspaces/replyOrigin");
    requests.push(payload.args.request);
    return new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
  } } },
  uiWorkspace: { selection, startSession() {} },
  sidebarRight: { openResource(address, options) { opened.push({ address, options }); } },
  effect(register) { cleanup.push(register()); },
});
const entry = () => slots.entriesOfSlot("conversation.chat.node").find((item) => item.options.key === "assistant-step");
assert.equal(entry(), undefined);
registerNative();
await new Promise((resolve) => setImmediate(resolve));
assert.notEqual(entry().component, NativeAssistant);
assert.equal(entry().locale, "native-chat");
assert.equal(entry().inject(sessionId).hooks.presentation, presentation);
assert.equal(entry().inject(sessionId).historySessionId, sessionId);
passed("late native assistant registration preserves its locale and injected presentation while binding the actual owning session");

const parent = { openFile() { throw new Error("A reply must not use the current workspace's file opener"); },
  openExternalLink(url) { external.push(url); }, fileImages: { resolve(path) { images.push(path); return "http://127.0.0.1:1/image.png"; }, labels: {} } };
const turn = { status: "closed" }, finalNode = { seq: 12, ...report.replyA };
const text = "[unicode](%E8%AF%B4%E6%98%8E%20%E7%A9%BA%E6%A0%BC.txt#L4-L9) [drive](C:/project/file.txt#L7) [external](https://example.com/guide) `说明 空格.txt` [unsafe](javascript:alert)";
const props = {
  node: { data: { status: "settled", turn: report.replyA.turn, step: report.replyA.step, blocks: [{ kind: "text", text }], finalNode }, location: { kind: "step", turn } },
  historySessionId: sessionId, useDisclosure: () => ({ expanded: false, toggle() {} }),
  useTurnData: () => ({ closing: { finalNode } }), usePresentation: (select) => select({}),
  renderMessageImages: () => null, openFile: parent.openFile, t: (key) => key,
  fileMentions(owner) { return { resolve(value) {
    return value === "说明 空格.txt" ? { title: value, label: "native mention", open: () => owner.openFile(value) } : undefined;
  } }; },
};
let root;
const render = (changes = {}) => React.createElement(primitives.MarkdownDelegateProvider, parent,
  React.createElement(entry().component, { ...props, ...changes }));
const button = (name) => root.root.findAllByType("button").find((item) => item.children.join("") === name || item.props["aria-label"] === name);
const origin = { binding: report.bindingA, scopeId: "remote-reply-file:" + JSON.stringify([sessionId, report.replyA.turn, report.replyA.step]) };
const finish = async (pending, result = { ok: true, value: origin }) => { await act(async () => { resolveReply(result); await pending; }); };
try {
  await act(async () => { root = create(render()); });
  let pending;
  await act(async () => { pending = button("unicode").props.onClick(); });
  assert.equal(opened.length, 0);
  await finish(pending);
  assert.equal(requests[0].sessionId, sessionId);
  assert.equal(requests[0].turn, report.replyA.turn); assert.equal(requests[0].step, report.replyA.step);
  assert.equal(opened[0].address, `dsh-resource://file/session/${encodeURIComponent(origin.scopeId)}/${encodeURIComponent("说明 空格.txt")}`);
  assert.equal(opened[0].options.params.line, 4);
  passed("actual native Markdown percent-decodes Unicode paths and preserves line ranges in the authoritative historical file scope");

  await act(async () => { pending = button("drive").props.onClick(); });
  await finish(pending);
  assert.equal(opened[1].address, `dsh-resource://file/session/${encodeURIComponent(origin.scopeId)}/C:/project/file.txt`);
  assert.equal(opened[1].options.params.line, 7);
  await act(async () => { pending = button("native mention").props.onClick(); });
  await finish(pending);
  assert.ok(opened[2].address.endsWith(encodeURIComponent("说明 空格.txt")));
  passed("native drive-letter links and prose file mentions share the same original-workspace opener");

  const link = root.root.findAllByType("a").find((item) => item.props.href === "https://example.com/guide");
  let prevented = 0;
  link.props.onClick({ button: 0, preventDefault() { prevented++; } });
  link.props.onClick({ button: 0, ctrlKey: true, preventDefault() { prevented++; } });
  assert.deepEqual(external, ["https://example.com/guide"]); assert.equal(prevented, 1);
  assert.ok(!root.root.findAllByType("a").some((item) => item.props.href.startsWith("javascript:")));
  passed("external links keep the original delegate and modified-click behavior while native unsafe-protocol filtering remains active");

  await act(async () => { root.update(render({ node: { ...props.node, data: { ...props.node.data, status: "running" } } })); });
  assert.equal(button("unicode"), undefined); assert.equal(button("native mention"), undefined);
  await act(async () => { root.update(render({ node: { ...props.node, data: { ...props.node.data, status: "interrupted" } } })); });
  await act(async () => { pending = button("unicode").props.onClick(); });
  await finish(pending);
  assert.equal(opened.length, 4);
  passed("native streaming keeps local links inert and interrupted replies keep their original step identity");

  await act(async () => { pending = button("unicode").props.onClick(); });
  selection.set({ sessionId: "other-session" });
  await finish(pending);
  assert.equal(opened.length, 4);
  selection.set({ sessionId });
  await act(async () => { pending = button("unicode").props.onClick(); });
  await finish(pending, { ok: false, error: { message: "Original workspace unavailable" } });
  await act(async () => { pending = button("unicode").props.onClick(); });
  await act(async () => { rejectReply(new Error("HTTP 503")); await pending; });
  assert.equal(opened.length, 4);
  passed("late replies after selecting another conversation and business or transport errors cannot open the current target as a fallback");

  await act(async () => { root.update(render({ node: { ...props.node, data: { ...props.node.data, blocks: [{ kind: "text", text: "![picture](pixel.png)" }] } } })); });
  const localImage = root.root.findByType("img");
  const localUrl = new URL(localImage.props.src);
  assert.equal(localUrl.pathname, "/api/remote-reply-image");
  assert.deepEqual(JSON.parse(localUrl.searchParams.get("reply")), [sessionId, report.replyA.turn, report.replyA.step]);
  assert.equal(localUrl.searchParams.get("path"), "pixel.png");
  assert.deepEqual(images, []);
  const imageBlocks = [{ kind: "text", text: "![relative](pixel.png) ![absolute](/original/project/pixel.png)" }];
  await act(async () => { root.update(render({ node: { ...props.node, data: { ...props.node.data, status: "running", blocks: imageBlocks } } })); });
  assert.equal(root.root.findAllByType("img").length, 0);
  await act(async () => { root.update(render({ node: { ...props.node, data: { ...props.node.data, status: "interrupted", blocks: imageBlocks } } })); });
  const interruptedImages = root.root.findAllByType("img");
  assert.deepEqual(interruptedImages.map((item) => new URL(item.props.src).searchParams.get("path")), ["pixel.png", "/original/project/pixel.png"]);
  assert.ok(interruptedImages.every((item) => JSON.parse(new URL(item.props.src).searchParams.get("reply"))[2] === report.replyA.step));
  await act(async () => { root.update(render({ node: { ...props.node, data: { ...props.node.data, blocks: [{ kind: "text", text: "![unicode](%E5%9B%BE%20%E7%89%87.png) ![external](https://example.com/picture.png) ![inline](data:image/png;base64,iVBORw0)" }] } } })); });
  const renderedImages = root.root.findAllByType("img");
  assert.equal(new URL(renderedImages[0].props.src).searchParams.get("path"), "图 片.png");
  assert.equal(renderedImages[1].props.src, "https://example.com/picture.png");
  assert.equal(renderedImages.length, 2);
  assert.ok(JSON.stringify(root.toJSON()).includes("inline"));
  passed("native local images use their reply identity and decoded Unicode paths, while external images and native protocol filtering remain intact");
} finally {
  if (root) await act(async () => root.unmount());
  for (const dispose of cleanup.reverse()) dispose?.();
  assert.equal(entry().component, NativeAssistant);
  disposeNative(); disposeFactory();
}
passed("teardown restores the original native assistant slot");
console.log(JSON.stringify({ checks, passed: true }));

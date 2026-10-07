/** Read-only UI filesystem operations. Model file tools remain upstream Pi tools. */
import { createReadStream } from "node:fs";
import { lstat, open, realpath, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const maxBytes = 8 * 1024 * 1024;
const fileSearches = new Map();
export function invalidateWorkspaceReferences(workspace) {
  fileSearches.get(workspace)?.search.invalidate();
}
async function references(workspace, root, query, signal) {
  if (typeof query !== "string" || query.length > 4096 || query.includes("\0")) throw new Error("Invalid file reference query");
  let entry = fileSearches.get(workspace);
  if (entry?.root !== root) {
    entry?.search.dispose();
    entry = { root, search: new DshFileSearch.WorkspaceFileSearch(root, {
      maxResults: DshFileSearch.DEFAULT_FILE_SEARCH_MAX_RESULTS,
      maxEntries: DshFileSearch.DEFAULT_FILE_SEARCH_MAX_ENTRIES,
      excludedDirectories: DshFileSearch.DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
    }), checkedAt: Date.now() };
    fileSearches.set(workspace, entry);
  }
  // Native tool results invalidate immediately. External edits are picked up
  // by a later fuzzy query; directory queries always read the live directory.
  if (Date.now() - entry.checkedAt > 5000) {
    entry.search.invalidate(); entry.checkedAt = Date.now();
  }
  return entry.search.list(query, signal);
}
function integer(value, fallback, minimum, maximum) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid file read range");
  return value;
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function readWorkspaceFile(workspace, request, signal) {
  signal.throwIfAborted();
  const root = await realpath(workspace);
  if (request.op === "references") return references(workspace, root, request.query, signal);
  const input = request.path ?? homedir();
  if (typeof input !== "string" || input.includes("\0")) throw new Error("Invalid filesystem path");
  const path = await realpath(resolve(root, input));
  if (!inside(root, path)) throw new Error("Path is outside the selected workspace");
  const info = await stat(path);
  const metadata = { absolutePath: path, version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`, bytes: info.size };
  if (request.op === "stat") return { ...metadata, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other" };
  if (request.op === "list") {
    if (!info.isDirectory()) throw new Error("Path is not a directory");
    const names = (await readdir(path)).sort();
    const entries = await Promise.all(names.slice(0, 2000).map(async (name) => {
      signal.throwIfAborted();
      try {
        const child = await realpath(resolve(path, name));
        if (!inside(root, child)) return { name, type: "other" };
        const item = await stat(child);
        return { name, type: item.isDirectory() ? "directory" : item.isFile() ? "file" : "other", ...(item.isFile() ? { size: item.size } : {}) };
      } catch { return { name, type: "other" }; }
    }));
    return { path: relative(root, path).split(sep).join("/"), absolutePath: path, home: homedir(), entries, truncated: names.length > entries.length, version: metadata.version };
  }
  if (!info.isFile()) throw new Error("Only regular files can be previewed");
  if (request.op === "bytes") {
    const offset = integer(request.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const length = integer(request.length, info.size || 1, 1, maxBytes);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, info.size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      signal.throwIfAborted();
      return { ...metadata, offset, base64: buffer.subarray(0, bytesRead).toString("base64"), eof: offset + bytesRead >= info.size };
    } finally { await handle.close(); }
  }
  if (request.op !== "text") throw new Error("Unknown filesystem operation");
  const offset = integer(request.offset, 1, 1, 1000000);
  const limit = integer(request.limit, 200, 1, 2000);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const stream = createReadStream(path, { signal });
  let scanned = 0, current = 1, tail = "", lines = [], eof = true;
  try {
    outer: for await (const chunk of stream) {
      scanned += chunk.length;
      if (scanned > maxBytes) throw new Error("Text preview exceeds the scan limit");
      tail += decoder.decode(chunk, { stream: true });
      if (tail.includes("\0")) throw new Error("Binary file cannot be previewed as text");
      let newline;
      while ((newline = tail.indexOf("\n")) >= 0) {
        const line = tail.slice(0, newline);
        tail = tail.slice(newline + 1);
        if (current++ < offset) continue;
        if (lines.length === limit) { eof = false; break outer; }
        lines.push(line);
      }
    }
    if (eof) {
      tail += decoder.decode();
      if (tail && current >= offset) {
        if (lines.length === limit) eof = false;
        else lines.push(tail);
      }
    }
    return { ...metadata, offset, text: lines.join("\n"), lines: lines.length, eof };
  } finally { stream.destroy(); }
}

// BEGIN vendored DSH file search
/*
 * Generated by dsh-product/sync-file-search.mjs from
 * @deepseek-ai/dsh-file-reference-local@0.2.0-rc.2 /search.
 * Search logic is unchanged; imports and exports are adapted for this bundle.
 *
 * MIT License
 *
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const DshFileSearch = (() => {
/**
 * Host-workspace discovery for `@file` completion. The index contains paths
 * only: selected values remain ordinary prompt text and file contents stay
 * behind the model-facing `read` tool.
 *
 * @module @deepseek-ai/dsh-file-reference-local/search
 */



/** Default maximum file and directory candidates rendered for one query. */
const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20;
/** Default maximum entries retained in one workspace search index. */
const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 50_000;
/**
 * Directory basenames omitted from traversal unless the deployment overrides
 * them: version-control and dependency stores plus build-output names that no
 * ecosystem also uses for sources. Generated files carry the basenames of the
 * sources that produced them, so an unfiltered tree both spends the entry
 * budget twice and ranks `dist/x.js` beside `src/x.ts` for every query.
 *
 * `lib` is deliberately absent: Ruby gems and many npm packages keep their
 * sources there, and excluding it would make `@` miss those sources entirely
 * and silently. A workspace that builds into `lib` adds it through
 * `excludedDirectories`.
 */
const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES = [
    '.git',
    'node_modules',
    'dist',
    'build',
    'out',
    'coverage',
    'target',
    '.next',
    '.nuxt',
    '.turbo',
    '.venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.gradle',
];
/**
 * Cancellable, reusable fuzzy index rooted at one agent working directory.
 * Directory-scoped queries list live state; bare fuzzy queries share one
 * bounded traversal. Only the first query of a workspace waits for that
 * traversal — an invalidated index keeps answering while its replacement
 * builds behind the caret.
 */
class WorkspaceFileSearch {
    root;
    config;
    excludedDirectories;
    settled;
    generation;
    /** Monotonic invalidation counter; a settled index below it is stale. */
    invalidations = 0;
    disposed = false;
    constructor(root, config) {
        this.root = root;
        this.config = config;
        if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) {
            throw new Error('file search maxResults must be a positive safe integer');
        }
        if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) {
            throw new Error('file search maxEntries must be a positive safe integer');
        }
        if (config.excludedDirectories.some(name => name.length === 0 || name.includes('/') || name.includes('\\'))) {
            throw new Error('file search excludedDirectories entries must be non-empty directory basenames');
        }
        this.excludedDirectories = new Set(config.excludedDirectories);
    }
    /**
     * Return ranked path candidates for the current token.
     * @param rawQuery - path text following `@` or `@"`.
     * @param signal - cancels this caller's wait without killing an index shared by a newer query.
     * @returns at most `maxResults` deterministic candidates.
     */
    async list(rawQuery, signal) {
        signal.throwIfAborted();
        if (this.disposed)
            return [];
        const query = rawQuery.replaceAll('\\', '/');
        const slash = query.lastIndexOf('/');
        if (query === '' || slash >= 0) {
            const directory = slash < 0 ? '' : query.slice(0, slash + 1);
            const fragment = slash < 0 ? '' : query.slice(slash + 1);
            return this.listDirectory(directory, fragment, signal);
        }
        const indexed = await this.indexFor(signal);
        return rankCandidates(indexed.filter(candidate => visibleForGlobalQuery(candidate.path, query)), query, this.config.maxResults);
    }
    /**
     * Mark the index stale so a later bare query observes a fresh tree.
     *
     * The stale entries are kept and keep answering: a rebuild costs one
     * traversal of the whole workspace, and putting that in front of the caret
     * is what a caller invalidating on every tool result would otherwise pay.
     */
    invalidate() {
        this.invalidations += 1;
    }
    /** Abort traversal and make later queries return no candidates. */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.generation?.controller.abort(new Error('file search index disposed'));
        this.generation = undefined;
        this.settled = undefined;
    }
    /**
     * The entries a bare fuzzy query ranks. Only the first query of a workspace
     * waits for a traversal; afterwards a stale index answers immediately and
     * its replacement builds in the background.
     * @param signal - cancels this caller's wait without killing a shared traversal.
     * @returns indexed paths, at most one invalidation behind the tree.
     */
    async indexFor(signal) {
        const settled = this.settled;
        if (settled === undefined)
            return waitForPromise(this.ensureIndex(), signal);
        if (settled.startedAt < this.invalidations) {
            void this.ensureIndex().catch(() => {
                // A background refresh failure is not this caller's error: the stale
                // entries still answer and `settled.startedAt` stays behind, so the
                // next bare query starts a fresh attempt.
            });
        }
        return settled.entries;
    }
    ensureIndex() {
        if (this.generation !== undefined)
            return this.generation.promise;
        const controller = new AbortController();
        const startedAt = this.invalidations;
        const generation = {
            controller,
            promise: Promise.resolve([]),
        };
        generation.promise = this.scanWorkspace(controller.signal).then((entries) => {
            /* v8 ignore next -- disposal aborts this traversal, so it reaches the
             * rejection handler instead; the guard only covers a scan that finished
             * its last directory in the instant before the abort landed, and must
             * not hand a disposed index its entries back. */
            if (this.disposed)
                return entries;
            this.generation = undefined;
            this.settled = { entries, startedAt };
            return entries;
        }, (error) => {
            /* v8 ignore next -- dispose clears `generation` synchronously; this only protects an unexpected scan failure */
            if (this.generation === generation)
                this.generation = undefined;
            throw error;
        });
        this.generation = generation;
        return generation.promise;
    }
    async scanWorkspace(signal) {
        const indexed = [];
        const directories = [{ absolute: this.root, relative: '' }];
        for (let cursor = 0; cursor < directories.length && indexed.length < this.config.maxEntries; cursor += 1) {
            signal.throwIfAborted();
            const directory = directories[cursor];
            /* v8 ignore next 3 -- cursor is bounded by this exact queue's length. */
            if (directory === undefined) {
                throw new Error('file search selected a missing directory');
            }
            // The root is not a subtree: an unreadable branch costs its own
            // candidates, but an unreadable root means the traversal learned
            // nothing. Letting that settle would publish an empty index over
            // entries that are still good and leave no invalidation to retry from.
            const entries = cursor === 0
                ? await readWorkspaceRoot(directory.absolute, signal)
                : await readDirectory(directory.absolute, signal);
            for (const entry of entries) {
                signal.throwIfAborted();
                const path = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`;
                if (entry.isDirectory()) {
                    if (this.excludedDirectories.has(entry.name))
                        continue;
                    indexed.push({ path, kind: 'directory' });
                    directories.push({ absolute: join(directory.absolute, entry.name), relative: path });
                }
                else if (entry.isFile()) {
                    indexed.push({ path, kind: 'file' });
                }
                if (indexed.length >= this.config.maxEntries)
                    break;
            }
        }
        return indexed;
    }
    async listDirectory(displayDirectory, fragment, signal) {
        if (displayDirectory.split('/').some(segment => this.excludedDirectories.has(segment)))
            return [];
        const absolute = await resolveDisplayDirectory(this.root, displayDirectory, signal);
        if (absolute === undefined)
            return [];
        const entries = await readDirectory(absolute, signal);
        const candidates = [];
        for (const entry of entries) {
            if (entry.name.startsWith('.') && !fragment.startsWith('.'))
                continue;
            if (entry.isDirectory()) {
                if (this.excludedDirectories.has(entry.name))
                    continue;
                candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'directory' });
            }
            else if (entry.isFile()) {
                candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'file' });
            }
        }
        return rankCandidates(candidates, fragment, this.config.maxResults);
    }
}
async function resolveDisplayDirectory(root, displayDirectory, signal) {
    const resolvedRoot = resolve(root);
    const absolute = resolve(resolvedRoot, displayDirectory === '' ? '.' : displayDirectory);
    const fromRoot = relative(resolvedRoot, absolute);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
        return undefined;
    /* v8 ignore next -- only Windows can produce a cross-volume absolute relative path */
    if (isAbsolute(fromRoot))
        return undefined;
    let current = resolvedRoot;
    for (const segment of fromRoot.split(sep).filter(Boolean)) {
        signal.throwIfAborted();
        current = join(current, segment);
        try {
            const status = await lstat(current);
            signal.throwIfAborted();
            if (status.isSymbolicLink() || !status.isDirectory())
                return undefined;
        }
        catch (_error) {
            signal.throwIfAborted();
            return undefined;
        }
    }
    return absolute;
}
async function readWorkspaceRoot(absolute, signal) {
    signal.throwIfAborted();
    const entries = await readdir(absolute, { withFileTypes: true });
    signal.throwIfAborted();
    return entries.sort((left, right) => compareText(left.name, right.name));
}
async function readDirectory(absolute, signal) {
    signal.throwIfAborted();
    try {
        const entries = await readdir(absolute, { withFileTypes: true });
        signal.throwIfAborted();
        return entries.sort((left, right) => compareText(left.name, right.name));
    }
    catch (_error) {
        /* v8 ignore start -- Windows chmod cannot make the unreadable-directory fixture fail readdir; POSIX behavior covers this fallback. */
        signal.throwIfAborted();
        // An unreadable/missing subtree contributes no candidates; other readable
        // branches remain useful and autocomplete is advisory.
        return [];
        /* v8 ignore stop */
    }
}
function visibleForGlobalQuery(path, query) {
    if (query.startsWith('.') || query.includes('/.'))
        return true;
    return !path.split('/').some(segment => segment.startsWith('.'));
}
function rankCandidates(candidates, query, limit) {
    const ranked = [];
    for (const candidate of candidates) {
        const score = scoreCandidate(candidate, query);
        if (score !== undefined)
            ranked.push({ candidate, score });
    }
    ranked.sort((left, right) => right.score - left.score
        || kindRank(left.candidate.kind) - kindRank(right.candidate.kind)
        || (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length)
        || compareText(left.candidate.path, right.candidate.path));
    return ranked.slice(0, limit).map(entry => entry.candidate);
}
function scoreCandidate(candidate, query) {
    if (query === '')
        return 0;
    const path = candidate.path.toLowerCase();
    const name = path.slice(path.lastIndexOf('/') + 1);
    const needle = query.toLowerCase();
    const directoryBonus = candidate.kind === 'directory' ? 25 : 0;
    if (name === needle)
        return 1_000 + directoryBonus;
    if (name.startsWith(needle))
        return 900 + directoryBonus;
    if (name.includes(needle))
        return 700 + directoryBonus;
    if (path.includes(needle))
        return 500 + directoryBonus;
    const subsequence = subsequenceScore(path, needle);
    return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus;
}
function subsequenceScore(target, query) {
    let targetIndex = 0;
    let gap = 0;
    for (const character of query) {
        const found = target.indexOf(character, targetIndex);
        if (found < 0)
            return undefined;
        gap += found - targetIndex;
        targetIndex = found + 1;
    }
    return Math.max(0, 100 - gap);
}
function kindRank(kind) {
    return kind === 'directory' ? 0 : 1;
}
function compareText(left, right) {
    /* v8 ignore next -- entries and candidates are unique; host enumeration
     * order determines which comparison direction sort requests. */
    return left < right ? -1 : left > right ? 1 : 0;
}
function waitForPromise(promise, signal) {
    /* v8 ignore next -- `list()` checks this signal immediately before its synchronous call into this helper */
    if (signal.aborted)
        return Promise.reject(errorReason(signal.reason, 'file search aborted'));
    return new Promise((resolvePromise, rejectPromise) => {
        const onAbort = () => { rejectPromise(errorReason(signal.reason, 'file search aborted')); };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolvePromise(value);
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            rejectPromise(errorReason(error, 'file search index failed'));
        });
    });
}
function errorReason(reason, fallback) {
    return reason instanceof Error ? reason : new Error(fallback, { cause: reason });
}
return { WorkspaceFileSearch, DEFAULT_FILE_SEARCH_MAX_RESULTS, DEFAULT_FILE_SEARCH_MAX_ENTRIES, DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES };
})();
// END vendored DSH file search

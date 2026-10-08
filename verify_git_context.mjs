/** Verify prompt summaries against real Git states in a disposable repository. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatGitContext } from "./dsh-product/git-context.mjs";

mkdirSync(".local", { recursive: true });
const root = mkdtempSync(".local/git-context-");
const git = (...args) => execFileSync("git", [
  "-c", "user.name=Context fixture", "-c", "user.email=context@example.invalid",
  "-c", "commit.gpgsign=false", "-c", "core.quotePath=false", ...args,
], { cwd: root, encoding: "utf8" }).trimEnd();
const snapshot = () => ({ root: git("rev-parse", "--show-toplevel"), branch: git("branch", "--show-current"), status: git("status", "--short") });
const write = (name, text) => writeFileSync(join(root, name), text);
const checks = [];
const passed = (name) => { checks.push(name); process.stdout.write(`PASS ${name}\n`); };

try {
  git("init", "--quiet", "--initial-branch=main");
  for (const name of ["tracked.txt", "staged.txt", "both.txt", "old name.txt", "conflict.txt"]) write(name, "base\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Fixture baseline");
  const clean = snapshot();
  assert.equal(formatGitContext(clean, clean.root), "Current Git state: main; clean.");
  const oldCleanChars = `Current Git state:\n${JSON.stringify(clean)}`.length;
  const cleanChars = formatGitContext(clean, clean.root).length;
  assert(cleanChars < oldCleanChars / 2);
  passed("a clean repository fits one line without repeating the workspace path");

  assert(formatGitContext(clean, `${clean.root}/subproject`).includes(`Repository root: ${clean.root}`));
  assert(!formatGitContext({ ...clean, root: "C:/project" }, "C:\\project\\").includes("Repository root:"));
  passed("nested workspaces keep the repository scope and Windows separators avoid duplicate paths");

  write("tracked.txt", "unstaged\n");
  write("staged.txt", "staged\n");
  write("both.txt", "staged\n");
  git("add", "staged.txt", "both.txt");
  write("both.txt", "staged and unstaged\n");
  git("mv", "old name.txt", "重命名 name.txt");
  for (let i = 0; i < 80; i++) write(`untracked-${String(i).padStart(3, "0")}-${"long-name-".repeat(10)}.txt`, "new\n");
  const dirty = snapshot();
  const original = structuredClone(dirty);
  const summary = formatGitContext(dirty, dirty.root);
  assert(summary.startsWith("Current Git state: main; staged 3, unstaged 2, untracked 80."));
  assert(summary.includes("Showing 8/84 entries"));
  assert(summary.includes(dirty.status.split("\n").find((line) => line.startsWith("R "))));
  assert(summary.includes(" M tracked.txt"));
  assert(summary.length < 1100);
  assert(summary.length < JSON.stringify(dirty).length / 10);
  assert.deepEqual(dirty, original);
  passed("staging, overlapping changes and renames remain accurate in a bounded preview while raw context stays intact");

  // Short status uses lowercase m for modified submodule content.
  const submodules = formatGitContext({ ...clean, status: " m nested-lib\n ? other-lib" }, clean.root);
  assert(submodules.startsWith("Current Git state: main; unstaged 2."));
  assert(submodules.includes(" m nested-lib") && submodules.includes(" ? other-lib"));
  passed("submodule content and untracked content count as worktree changes");

  const long = formatGitContext({ ...clean, status: `?? ${"x".repeat(1200)}\n M tracked.txt` }, clean.root);
  assert(long.includes("untracked 1") && long.includes("unstaged 1"));
  assert(long.includes(" M tracked.txt") && long.includes("Showing 1/2 entries"));
  assert(!long.includes("xxx"));
  passed("an oversized path is omitted whole and its change remains in the counts");

  for (const status of [null, undefined, "unexpected Git output"]) {
    const unknown = formatGitContext({ ...clean, status }, clean.root);
    assert(unknown.includes("unavailable"));
    assert(!unknown.includes("clean"));
  }
  assert(formatGitContext({ ...clean, branch: null }, clean.root).includes("branch unavailable"));
  assert.equal(formatGitContext(null, clean.root), "");
  passed("failed or unrecognized status and missing branch information cannot masquerade as a clean checkout");

  git("reset", "--hard", "--quiet", "HEAD");
  git("clean", "-fd", "--quiet");
  git("checkout", "--quiet", "--detach", "HEAD");
  assert.equal(formatGitContext(snapshot(), clean.root), "Current Git state: detached HEAD; clean.");
  git("checkout", "--quiet", "main");
  passed("a detached checkout is stated explicitly");

  git("checkout", "--quiet", "-b", "other");
  write("conflict.txt", "other\n");
  git("commit", "--quiet", "-am", "Other version");
  git("checkout", "--quiet", "main");
  write("conflict.txt", "main\n");
  git("commit", "--quiet", "-am", "Main version");
  const merge = spawnSync("git", ["merge", "--no-edit", "other"], { cwd: root, encoding: "utf8" });
  assert.equal(merge.status, 1, merge.stderr);
  for (let i = 0; i < 20; i++) write(`aaa-untracked-${i}.txt`, "new\n");
  const conflict = snapshot();
  const conflictSummary = formatGitContext(conflict, conflict.root);
  assert(conflictSummary.includes("untracked 20, conflicts 1"));
  assert.equal(conflictSummary.split("\n")[1], "UU conflict.txt");
  const stale = formatGitContext(conflict, conflict.root, { stale: true });
  assert(stale.startsWith("Last known Git state (target unavailable; may be stale):"));
  assert(stale.includes("UU conflict.txt"));
  passed("real merge conflicts take preview priority and an offline snapshot stays marked stale");

  const report = { checks, clean: { oldChars: oldCleanChars, newChars: cleanChars }, dirty: { entries: dirty.status.split("\n").length, oldChars: JSON.stringify(dirty).length, newChars: summary.length } };
  writeFileSync(".local/verification-git-context.json", `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ clean: report.clean, dirty: report.dirty })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

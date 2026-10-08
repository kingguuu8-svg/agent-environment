/** Keep the prompt small; the workspace context API retains the full Git output. */
const conflicts = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const maxEntries = 8;
const maxStatusChars = 800;
const samePath = (a, b) => a.replaceAll("\\", "/").replace(/\/+$/, "") === b.replaceAll("\\", "/").replace(/\/+$/, "");

export function formatGitContext(git, workspace, { stale = false } = {}) {
  if (!git) return "";
  const label = stale ? "Last known Git state (target unavailable; may be stale)" : "Current Git state";
  const branch = git.branch === "" ? "detached HEAD" : git.branch ?? "branch unavailable";
  const lines = [];
  const entries = typeof git.status === "string" ? git.status.split(/\r?\n/).filter(Boolean) : null;
  if (entries === null) {
    lines.push(`${label}: ${branch}; status unavailable.`);
  } else if (!entries.length) {
    lines.push(`${label}: ${branch}; clean.`);
  } else {
    const counts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
    let recognized = true;
    for (const entry of entries) {
      const code = entry.slice(0, 2);
      if (!/^[ MADRCUT?!m]{2} /.test(entry)) { recognized = false; continue; }
      if (conflicts.has(code)) counts.conflicts++;
      else if (code === "??") counts.untracked++;
      else if (code !== "!!") {
        if (code[0] !== " ") counts.staged++;
        if (code[1] !== " ") counts.unstaged++;
      }
    }
    const summary = recognized ? Object.entries(counts).filter(([, count]) => count).map(([name, count]) => `${name} ${count}`).join(", ") : "status summary unavailable";
    lines.push(`${label}: ${branch}; ${summary || "status summary unavailable"}.`);
    // Conflicts and tracked changes matter more than a long untracked listing.
    const priority = (entry) => conflicts.has(entry.slice(0, 2)) ? 0 : entry.startsWith("??") ? 2 : 1;
    const preview = [];
    let chars = 0;
    for (const entry of [...entries].sort((a, b) => priority(a) - priority(b))) {
      if (preview.length === maxEntries) break;
      // Omit a long entry as a whole so a shortened path cannot name another file.
      if (chars + entry.length + 1 > maxStatusChars) continue;
      preview.push(entry);
      chars += entry.length + 1;
    }
    if (preview.length) lines.push(...preview);
    if (preview.length < entries.length) lines.push(`Showing ${preview.length}/${entries.length} entries; run \`git status --short\` for the full list.`);
  }
  if (git.root && !samePath(git.root, workspace)) lines.push(`Repository root: ${git.root}`);
  return lines.join("\n");
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface GitMeta {
  branch?: string;
  remotes: Array<{ name: string; url: string }>;
}

/**
 * Reads the current branch and remotes straight from `.git/HEAD` and
 * `.git/config`. No git process per repo, so scanning hundreds stays fast.
 */
export async function readGitMeta(repoDir: string): Promise<GitMeta> {
  const gitDir = join(repoDir, ".git");
  const [head, config] = await Promise.all([
    readFile(join(gitDir, "HEAD"), "utf8").catch(() => ""),
    readFile(join(gitDir, "config"), "utf8").catch(() => ""),
  ]);
  const branch = parseHead(head);
  const remotes = parseRemotes(config);
  return branch === undefined ? { remotes } : { branch, remotes };
}

/** `ref: refs/heads/main` gives `main`. A detached HEAD has no branch. */
export function parseHead(text: string): string | undefined {
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(text.trim());
  return match?.[1];
}

/** Remotes with their fetch URL, in file order. Handles quoting, escapes and comments. */
export function parseRemotes(text: string): Array<{ name: string; url: string }> {
  const urls = new Map<string, string>();
  let remote: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.startsWith("[")) {
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
      remote = header ? remoteName(header[1] ?? "", header[2]) : undefined;
      if (!header) continue;
      // A key may follow the header on the same line: `[remote "origin"] url = …`.
      line = line.slice(header[0].length).trim();
    }
    if (remote === undefined || line === "") continue;
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    if (!entry || urls.has(remote)) continue;
    const url = parseValue(entry[1] ?? "");
    if (url !== "") urls.set(remote, url);
  }
  return [...urls].map(([name, url]) => ({ name, url }));
}

/** `[remote "origin"]`, or the old `[remote.origin]` form. */
function remoteName(section: string, subsection: string | undefined): string | undefined {
  if (subsection !== undefined) {
    return section.toLowerCase() === "remote" ? subsection.replace(/\\(.)/g, "$1") : undefined;
  }
  return section.toLowerCase().startsWith("remote.") ? section.slice("remote.".length) : undefined;
}

/** A git config value: strips comments outside quotes, removes quotes, expands escapes. */
function parseValue(raw: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[++i];
      out += next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if ((ch === "#" || ch === ";") && !quoted) {
      break;
    } else {
      out += ch;
    }
  }
  return out.trim();
}

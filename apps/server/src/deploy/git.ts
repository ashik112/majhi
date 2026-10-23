import { errorMessage } from "../errors.ts";
import { git, gitOk, refIsThere } from "../git/git.ts";
import { conflictsBetween } from "../git/merge.ts";

/**
 * What a deploy decides from. The head is the base branch as the source remote has it (where the task landed): the
 * owner's local branch never decides, so a stale or diverged checkout blocks nothing. A local branch counts only when
 * it is strictly ahead of the source remote (a merge that was not pushed yet), because then it is the head.
 * `sync`: a deploy remote has commits the head lacks, so pushing the head there would not be a fast-forward.
 */
export type DeployHead =
  | { kind: "ready"; commit: string }
  | {
      kind: "sync";
      base: string;
      sourceRemote: string;
      deployRemote: string;
      sourceTip: string;
      deployTip: string;
      /** Commits the deploy remote has that the source lacks, and up to three of them. */
      deployOnly: number;
      deployOnlyLines: string[];
      /** Commits the source has that the deploy remote lacks. */
      sourceOnly: number;
      /** Files a test merge of the deploy remote's base into the source's conflicts in. Empty when it merges cleanly. */
      conflicts: string[];
    }
  | { kind: "unreadable"; why: string };

export type SyncHead = Extract<DeployHead, { kind: "sync" }>;

const SAMPLE = 3;

/** The head of the base branch for a deploy that runs on the `deploy` remotes, read from the remote refs as fetched. */
export async function readHeads(
  path: string,
  base: string,
  source: string,
  deploy: readonly string[],
): Promise<DeployHead> {
  try {
    const sourceRef = `refs/remotes/${source}/${base}`;
    const localRef = `refs/heads/${base}`;
    const rev = async (ref: string): Promise<string> => (await git(path, ["rev-parse", ref])).trim();
    let head: string | undefined;
    if (await refIsThere(path, sourceRef)) {
      head = await rev(sourceRef);
      if (await refIsThere(path, localRef)) {
        const local = await rev(localRef);
        if (local !== head && (await gitOk(path, ["merge-base", "--is-ancestor", head, local]))) head = local;
      }
    } else if (await refIsThere(path, localRef)) {
      head = await rev(localRef);
    }
    if (head === undefined) {
      return {
        kind: "unreadable",
        why: `majhi cannot read ${base} of ${source}: this project has no copy of it here.`,
      };
    }
    for (const remote of [...new Set(deploy)]) {
      if (remote === source) continue;
      const ref = `refs/remotes/${remote}/${base}`;
      if (!(await refIsThere(path, ref))) continue;
      const tip = await rev(ref);
      if (tip === head || (await gitOk(path, ["merge-base", "--is-ancestor", tip, head]))) continue;
      const count = async (range: string): Promise<number> =>
        Number((await git(path, ["rev-list", "--count", range])).trim()) || 0;
      const lines = (await git(path, ["log", "--format=%h %s", `-${SAMPLE}`, `${head}..${tip}`]))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      return {
        kind: "sync",
        base,
        sourceRemote: source,
        deployRemote: remote,
        sourceTip: head,
        deployTip: tip,
        deployOnly: await count(`${head}..${tip}`),
        deployOnlyLines: lines,
        sourceOnly: await count(`${tip}..${head}`),
        conflicts: await conflictsBetween(path, head, tip).catch(() => []),
      };
    }
    return { kind: "ready", commit: head };
  } catch (err) {
    return {
      kind: "unreadable",
      why: `majhi could not read the project's base branch: ${errorMessage(err)}`,
    };
  }
}

const plural = (count: number): string => `${count} commit${count === 1 ? "" : "s"}`;

/** What is the matter with a deploy remote that is ahead, in a sentence. */
export function syncFact(h: SyncHead): string {
  const theirs = `${h.deployRemote}/${h.base}`;
  const ours = `${h.sourceRemote}/${h.base}`;
  const what = h.deployOnlyLines.length === 0 ? "" : ` (${h.deployOnlyLines.join("; ")})`;
  const other = h.sourceOnly === 0 ? "" : `, and ${ours} has ${plural(h.sourceOnly)} ${theirs} lacks`;
  return `${theirs} has ${plural(h.deployOnly)} ${ours} lacks${what}${other}`;
}

/** What a deploy reads from a project's repository. Read only. */
export interface DeployGit {
  /** The head a deploy ships, read from the source remote's base and checked against each deploy remote's. */
  heads(path: string, base: string, source: string, deploy: readonly string[]): Promise<DeployHead>;
  /** The newest tip of the base branch: the local branch and each remote's copy, whichever contains the others. For reading files only: a deploy decides from `heads`. */
  tip(path: string, base: string): Promise<string | undefined>;
  /** The base branch as one remote has it, or undefined when that copy is not there. For reading files, never for deploying. */
  remoteTip?(path: string, base: string, remote: string): Promise<string | undefined>;
  /** A file at a commit, or undefined when the commit has none. */
  file(path: string, commit: string, name: string): Promise<string | undefined>;
  /** The entries of a folder at a commit (`""` is the root); empty when it has none. Symlinks are left out. */
  list(path: string, commit: string, dir: string): Promise<{ name: string; dir: boolean }[]>;
}

/** A letter, digit or `_`: what an environment variable's name is made of. */
export function isNameChar(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_";
}

/** The keys a .env file sets: `KEY=value` lines, comments and blank lines skipped. Never a value. */
export function envKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (key !== "" && [...key].every(isNameChar)) keys.push(key);
  }
  return [...new Set(keys)];
}

export const deployGit: DeployGit = {
  heads: readHeads,
  async file(path, commit, name) {
    return git(path, ["show", `${commit}:${name}`]).catch(() => undefined);
  },
  async list(path, commit, dir) {
    try {
      const out = await git(path, dir === "" ? ["ls-tree", commit] : ["ls-tree", commit, `${dir}/`]);
      const entries: { name: string; dir: boolean }[] = [];
      for (const line of out.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const [mode, type] = line.slice(0, tab).split(" ");
        if (mode === "120000") continue;
        const name = line
          .slice(tab + 1)
          .split("/")
          .at(-1);
        if (name !== undefined && name !== "") entries.push({ name, dir: type === "tree" });
      }
      return entries;
    } catch {
      return [];
    }
  },
  async remoteTip(path, base, remote) {
    try {
      const ref = `refs/remotes/${remote}/${base}`;
      return (await refIsThere(path, ref)) ? (await git(path, ["rev-parse", ref])).trim() : undefined;
    } catch {
      return undefined;
    }
  },
  async tip(path, base) {
    try {
      const remotes = (await git(path, ["remote"])).split("\n").filter((r) => r.trim() !== "");
      const refs = [`refs/heads/${base}`, ...remotes.map((r) => `refs/remotes/${r.trim()}/${base}`)];
      const tips: string[] = [];
      for (const ref of refs) {
        if (await refIsThere(path, ref)) tips.push((await git(path, ["rev-parse", ref])).trim());
      }
      let best: string | undefined;
      for (const tip of tips) {
        if (
          best === undefined ||
          (tip !== best && (await gitOk(path, ["merge-base", "--is-ancestor", best, tip])))
        ) {
          best = tip;
        } else if (tip !== best && !(await gitOk(path, ["merge-base", "--is-ancestor", tip, best]))) {
          // Two copies that each have commits the other lacks: no single head to deploy.
          return undefined;
        }
      }
      return best;
    } catch {
      return undefined;
    }
  },
};

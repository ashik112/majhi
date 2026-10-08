import { git, gitOk, refIsThere } from "../git/git.ts";

/** What a deploy reads from a project's repository. Read only. */
export interface DeployGit {
  /** The newest tip of the base branch: the local branch and each remote's copy, whichever contains the others. */
  tip(path: string, base: string): Promise<string | undefined>;
  /** Why there is no tip, in a sentence: the copies of the base branch differ (and which commits), or git cannot be read. */
  whyNoTip(path: string, base: string): Promise<string>;
  /** A file at a commit, or undefined when the commit has none. */
  file(path: string, commit: string, name: string): Promise<string | undefined>;
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

const PLAIN = "majhi could not read the project's base branch.";

export const deployGit: DeployGit = {
  async file(path, commit, name) {
    return git(path, ["show", `${commit}:${name}`]).catch(() => undefined);
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
  async whyNoTip(path, base) {
    try {
      const remotes = (await git(path, ["remote"])).split("\n").filter((r) => r.trim() !== "");
      const refs = [`refs/heads/${base}`, ...remotes.map((r) => `refs/remotes/${r.trim()}/${base}`)];
      const there: string[] = [];
      for (const ref of refs) if (await refIsThere(path, ref)) there.push(ref);
      for (const [i, a] of there.entries()) {
        for (const b of there.slice(i + 1)) {
          if (
            (await gitOk(path, ["merge-base", "--is-ancestor", a, b])) ||
            (await gitOk(path, ["merge-base", "--is-ancestor", b, a]))
          )
            continue;
          const short = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
          const only = async (from: string, other: string) => {
            const lines = (await git(path, ["log", "--format=%h %s", "-3", `${other}..${from}`])).trim();
            return lines === "" ? "none" : lines.split("\n").join("; ");
          };
          return `${short(a)} and ${short(b)} each have commits the other lacks, so there is no one head to deploy. ${short(a)} only: ${await only(a, b)}. ${short(b)} only: ${await only(b, a)}. Merge them in the project, then deploy.`;
        }
      }
    } catch {
      return PLAIN;
    }
    return PLAIN;
  },
};

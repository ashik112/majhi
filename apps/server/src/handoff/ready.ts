import type { ShipCheck } from "../captain/ports.ts";
import { git } from "../git/git.ts";
import { mergeConflicts } from "../git/merge.ts";
import { changeBase } from "../git/since-start.ts";
import type { MrService } from "../mrs/service.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import { describeHit, type SecretScan, scanForSecrets } from "./secret-scan.ts";

/**
 * The cheap checks of a task in review, read live each time: it is in review and no agent works in
 * it, no card waits for the owner, it changes no protected repo, something changed, it is committed,
 * it merges cleanly into its base, and the diff holds no secret. The ship chore, the captain's lane
 * and the checked hand-off all read the same answer (SPEC 5.18, "One way to ship").
 *
 * A reason only the owner can clear (a card waits, a protected repo) carries `owner`: the lead is not
 * told about it.
 */

export interface ReadyDeps {
  store: Pick<Store, "tasks" | "room">;
  room: Pick<RoomService, "flush">;
  runs: { working(task: string): string[] };
  mrs: Pick<MrService, "shipOptions">;
}

const WAITING = ["approval", "ask", "choice", "owner-question", "secret-request", "permission"] as const;

/** `except`: a pending card that does not count as waiting, the lead's own merge card the captain is answering. */
export async function shipReadiness(deps: ReadyDeps, id: string, except?: string): Promise<ShipCheck> {
  const { store } = deps;
  const task = store.tasks.get(id);
  if (task === undefined || task.status !== "review")
    return { ready: false, why: "it is not in review", owner: true };
  if (deps.runs.working(id).length > 0)
    return { ready: false, why: "an agent is still working", owner: true };
  deps.room.flush(id);
  const waiting = WAITING.find((type) => store.room.pendingOfType(id, type).some((i) => i.id !== except));
  if (waiting !== undefined) {
    const card = waiting.replace("-", " ");
    return {
      ready: false,
      why: `${/^[aeiou]/.test(card) ? "an" : "a"} ${card} card waits for you`,
      owner: true,
    };
  }
  const options = await deps.mrs.shipOptions(id);
  if ((options.protected ?? []).length > 0) {
    return { ready: false, why: "it changes a protected repo, which only you ship", owner: true };
  }
  const changed = options.changed ?? [];
  if (changed.length === 0)
    return { ready: false, why: "nothing changed since it started", owner: true, unmergeable: "empty" };
  if (!options.merge.ok)
    return { ready: false, why: options.merge.why ?? "it cannot merge now", unmergeable: "failing" };
  // Merges cleanly means git says so now, not that something is ahead: main may have moved since.
  for (const c of changed) {
    const repo = task.repos.find((r) => r.project === c.project);
    if (repo === undefined) continue;
    const conflicts = await mergeConflicts(repo.source, repo.branch, c.base).catch(() => []);
    if (conflicts.length > 0) {
      const listed = `${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? " and more" : ""}`;
      return {
        ready: false,
        why: `it conflicts with ${c.base} in ${listed}`,
        conflict: true,
        unmergeable: "failing",
      };
    }
  }
  for (const repo of task.repos) {
    const files = repo.worktree === undefined ? [] : await uncommittedFiles(repo.worktree);
    if (files === undefined)
      return { ready: false, why: `the changes of ${repo.project} could not be read`, owner: true };
    if (files.length > 0) {
      const listed = `${files.slice(0, 8).join(", ")}${files.length > 8 ? " and more" : ""}`;
      return {
        ready: false,
        why: `${repo.project} has uncommitted changes: ${listed}`,
        uncommitted: { project: repo.project, files: files.slice(0, 20) },
        unmergeable: "failing",
      };
    }
    // A merge request carries what the branch adds over its base now. The start commit is not that
    // once main moved or was merged in, so the scan measures from the merge base.
    const scan = await scanRepoDiff(repo);
    if (scan === undefined)
      return { ready: false, why: `the diff of ${repo.project} could not be read`, owner: true };
    if (scan.kind === "secret")
      return {
        ready: false,
        why: `the diff of ${repo.project} holds what looks like a secret: ${describeHit(scan.hit)}`,
        unmergeable: "failing",
      };
    if (scan.kind === "too-large") {
      return {
        ready: false,
        why: `the diff of ${repo.project} is too large to check for secrets: ${scan.why}`,
        owner: true,
      };
    }
  }
  const into = [...new Set(changed.map((c) => c.base))].join(", ");
  return {
    ready: true,
    evidence: `committed, merges cleanly into ${into}, no card waits, no secret in the diff`,
    targets: changed.map((c) => ({ project: c.project, into: c.base, base: c.base })),
  };
}

/**
 * The secret scan of what a repo's branch adds over its base now: the one scan the ship checks and
 * the merge rule share. Undefined when git cannot say.
 */
export async function scanRepoDiff(repo: {
  source: string;
  base: string;
  branch: string;
  worktree?: string | undefined;
  startCommit?: string | undefined;
}): Promise<SecretScan | undefined> {
  const cwd = repo.worktree ?? repo.source;
  const tip = `refs/heads/${repo.branch}`;
  return changeBase(cwd, repo, tip, { mergeBase: true })
    .then((from) => scanForSecrets(cwd, from.commit, tip))
    .catch(() => undefined);
}

/** Package folders majhi manages (its shared store is outside the worktree): never the agent's work when untracked. */
const MANAGED_FOLDERS: ReadonlySet<string> = new Set([".pnpm-store", "node_modules"]);

/**
 * The files of `git status --porcelain=v1 -z` that count as uncommitted work. Ignored files are not
 * work, and neither is an untracked package store or `node_modules`. Modified or staged tracked files
 * and untracked source files count.
 */
export function uncommittedFromStatus(raw: string): { files: string[]; untrackedDirs: string[] } {
  const entries = raw.split("\0");
  const files: string[] = [];
  const untrackedDirs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length <= 3) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename lists its old path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") i++;
    if (status === "!!") continue;
    if (status === "??" && path.split("/").some((part) => MANAGED_FOLDERS.has(part))) continue;
    // git lists a folder of only untracked files as one entry: it may hold nothing but a store.
    if (status === "??" && path.endsWith("/")) untrackedDirs.push(path);
    else files.push(path);
  }
  return { files, untrackedDirs };
}

/** The files a worktree changed and did not commit, new ones included. Undefined when git cannot say. */
export async function uncommittedFiles(worktree: string): Promise<string[] | undefined> {
  try {
    const out = await git(worktree, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z"]);
    const { files, untrackedDirs } = uncommittedFromStatus(out);
    for (const dir of untrackedDirs) {
      const listed = await git(worktree, [
        "-c",
        "core.quotePath=false",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        dir,
        ...[...MANAGED_FOLDERS].map((name) => `:(exclude,glob)**/${name}/**`),
      ]);
      files.push(...listed.split("\0").filter((p) => p !== ""));
    }
    return files;
  } catch {
    return undefined;
  }
}

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitAttribution } from "@majhi/acp";
import { agentCommitter, attributionEnabled, TASK_TRAILER } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { DEFAULT_IDENTITY, type Identity } from "./checkpoint.ts";

/**
 * Who an agent's own `git commit` is made as (SPEC 5.7): the org's commit identity as author, the
 * agent as committer, and a `Majhi-Task` trailer added by a hook majhi owns. Checkpoints get the
 * same through `commitBy`.
 */

/** Git hooks that run around a commit, a checkout, a merge, a rebase or a push. */
const HOOKS = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-merge-commit",
  "post-merge",
  "pre-rebase",
  "post-rewrite",
  "post-checkout",
  "pre-push",
] as const;

/**
 * Every hook runs the repo's own hook of the same name, so the repo's checks still run, and
 * `prepare-commit-msg` adds the trailer first. It runs even under `--no-verify`, which skips
 * `commit-msg`. The repo's hooks are where its own `core.hooksPath` says (husky, lefthook), read
 * with `--local` because majhi's override sits in the command-line scope, else in the git folder.
 * A relative path is from the worktree's top, where hooks run. The repo's hooks stay read-only for
 * the agent (5.15).
 */
const SCRIPT = `#!/bin/sh
name=$(basename "$0")
if [ "$name" = prepare-commit-msg ] && [ -n "$MAJHI_TASK" ]; then
  git interpret-trailers --in-place --if-exists doNothing --trailer "${TASK_TRAILER}: $MAJHI_TASK" "$1" || exit 1
fi
repo_hooks=$(git config --local --get core.hooksPath)
[ -n "$repo_hooks" ] || repo_hooks="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$repo_hooks/$name" ]; then exec "$repo_hooks/$name" "$@"; fi
exit 0
`;

/**
 * Writes majhi's hooks under its home. Returns the folder, which a run mounts read-only. A script
 * is written only when it differs, and by rename, so a run executing one never reads half a file.
 */
export async function ensureHooks(majhiHome: string): Promise<string> {
  const dir = join(majhiHome, "git-hooks");
  await mkdir(dir, { recursive: true });
  for (const name of HOOKS) {
    const path = join(dir, name);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === SCRIPT) continue;
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, SCRIPT, { mode: 0o755 });
    await chmod(temp, 0o755);
    await rename(temp, path);
  }
  return dir;
}

/** The org's commit identity for a task, or majhi's own when the org has none. */
export async function orgIdentity(config: ConfigService, org: string | undefined): Promise<Identity> {
  return (await config.sections()).orgs[org ?? "private"]?.identity ?? DEFAULT_IDENTITY;
}

export interface TaskAttribution {
  /** Each repo's own setting, by project. */
  repos: Record<string, boolean>;
  /** For a run, which works in every repo of the task: off when any repo is off. */
  run: boolean;
}

/**
 * Whether commits name the agent and the task, per repo of a task: the project's setting, else its
 * org's, else majhi's. Read each time, so a change applies to the next checkpoint at once.
 */
export async function attributionOf(
  config: ConfigService,
  task: { org?: string | undefined; repos: readonly { project: string }[] },
): Promise<TaskAttribution> {
  const [settings, sections] = await Promise.all([config.settings(), config.sections()]);
  const global = settings.commits;
  const repos: Record<string, boolean> = {};
  for (const { project } of task.repos) {
    const p = sections.projects[project];
    repos[project] = attributionEnabled({
      project: p?.commits,
      org: sections.orgs[p?.org ?? task.org ?? "private"]?.commits,
      global,
    });
  }
  const run =
    task.repos.length === 0
      ? attributionEnabled({ org: sections.orgs[task.org ?? "private"]?.commits, global })
      : Object.values(repos).every(Boolean);
  return { repos, run };
}

/**
 * The git environment of one agent's run in a task. With attribution off it is the org's identity
 * for author and committer, no task and no hooks, so the repo's hooks run as they always did.
 */
export async function gitAttribution(
  deps: { config: ConfigService; majhiHome: string },
  task: { id: string; org?: string | undefined; repos: readonly { project: string }[] },
  agent: string,
): Promise<{ git: GitAttribution; hooks?: string }> {
  const [author, on] = await Promise.all([
    orgIdentity(deps.config, task.org),
    attributionOf(deps.config, task),
  ]);
  if (!on.run) return { git: { author, committer: author } };
  const hooks = await ensureHooks(deps.majhiHome);
  return { git: { author, committer: agentCommitter(agent), task: task.id, hooks }, hooks };
}

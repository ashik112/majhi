import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type GitAttribution, MAJHI_HOOKS_DIR } from "@majhi/acp";
import { agentCommitter, attributionEnabled, TASK_TRAILER } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { ensureWorktreeExcludes } from "../git/worktree-excludes.ts";
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
  "reference-transaction",
] as const;

/**
 * Every hook runs the repo's own hook of the same name, so the repo's checks still run, and
 * `prepare-commit-msg` adds the trailer first when attribution is on (`MAJHI_TRAILER`). It runs even
 * under `--no-verify`, which skips `commit-msg`. The repo's hooks are where its own `core.hooksPath`
 * says (husky, lefthook), read with `--local` because majhi's override sits in the command-line
 * scope, else in the git folder. A relative path is from the worktree's top, where hooks run. The
 * repo's hooks stay read-only for the agent (5.15).
 *
 * `reference-transaction` keeps a run on its own task's branches. Every task worktree shares the
 * repo's git folder with the owner's checkout, so without it a run could move or delete the owner's
 * branches (main, release/*), another task's branch, the remote-tracking refs majhi reads to tell
 * what is merged or pushed, tags, notes or the shared stash. With the locks taken ("prepared", where a
 * non-zero exit aborts the whole change) and `MAJHI_TASK` set, it allows only:
 * - the task's branches: the ones named in `MAJHI_BRANCHES` (`feat/<id>-<slug>`), and `task/<id>` and
 *   `task/<id>-*` of older tasks,
 *   except a deletion or rename of a branch majhi tracks (`MAJHI_BRANCHES`): git renames by deleting
 *   first, and a rename the guard then stops halfway would lose the branch;
 * - the worktree's own HEAD (detached, or switched to one of those branches) and the refs git keeps
 *   per worktree: pseudo refs like ORIG_HEAD and MERGE_HEAD, `refs/bisect`, `refs/worktree`,
 *   `refs/rewritten`;
 * and nothing at all from the project's own checkout, where a run never works. Only the task's repos
 * are guarded (`MAJHI_GIT_DIRS`, the only git folders a run can write): a repo the agent makes for
 * itself, like a test's, stays free. Every line counts: git
 * reports a deletion and a `verify` alike (new value all zeros), so a harmless line cannot be told
 * apart. Git reports a branch switch as HEAD becoming `ref:<branch>` from 2.46; older git (the runner
 * image's) does not, so `post-checkout` switches back to where the worktree was and fails the
 * checkout. Without `MAJHI_TASK` (the owner's git, majhi's own) nothing is refused. The input is kept
 * and passed on to the repo's own hook of that name.
 *
 * This is a guard rail against mistakes and plain commands, not a wall: the run can write files in
 * the shared git folder directly or turn the hooks off for one command.
 */
const SCRIPT = `#!/bin/sh
name=$(basename "$0")
set -f
own="refs/heads/task/$(printf '%s' "$MAJHI_TASK" | tr '[:upper:]' '[:lower:]')"
# Succeeds for a branch of the run's own task.
is_own() {
  case "$1" in
    "$own" | "$own"-*) return 0 ;;
  esac
  for b in $MAJHI_BRANCHES; do
    [ "$1" = "refs/heads/$b" ] && return 0
  done
  return 1
}
# Succeeds for a branch majhi tracks as the task's working branch, by name.
is_tracked() {
  for b in $MAJHI_BRANCHES; do
    [ "$1" = "refs/heads/$b" ] && return 0
  done
  return 1
}
# Succeeds when git works on one of the task's repos (MAJHI_GIT_DIRS), by either form of its path.
guarded() {
  [ -n "$MAJHI_TASK" ] && [ -n "$MAJHI_GIT_DIRS" ] || return 1
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  real=$(cd "$common" 2>/dev/null && pwd -P)
  [ -n "$real" ] || real=$common
  printf '%s\\n' "$MAJHI_GIT_DIRS" | grep -Fqx -e "$common" -e "$real"
}
# Prints why a run may not set ref $2 to $1, or nothing when it may. A switch of HEAD ranks after
# the branch it names, whose reason says more ("2 " and "1 ", cut before showing).
refusal() {
  case "$2" in
    HEAD)
      case "$1" in
        ref:*) is_own "\${1#ref:}" || echo "2 this worktree stays on its task branch, so it cannot switch to \${1#ref:refs/heads/}. Read another branch with git show or git diff, or look at it with git checkout --detach." ;;
      esac ;;
    refs/heads/task/*)
      case "$1" in
        *[!0]*) ;;
        *) is_tracked "$2" && echo "1 majhi tracks \${2#refs/heads/} as the branch of $MAJHI_TASK, so it cannot be deleted or renamed." && return ;;
      esac
      is_own "$2" || {
        other=\${2#refs/heads/}
        id=$(printf '%s' "$other" | sed -n 's|^task/\\([a-z][a-z0-9]*-[0-9][0-9]*\\).*|\\1|p' | tr '[:lower:]' '[:upper:]')
        echo "1 $other is the branch of another task\${id:+ ($id)}, not of $MAJHI_TASK. Do not change it with git: its worktree would not follow and its agents would undo the change. Use the majhi-tasks change_task_branch tool, which commits inside that task's own worktree."
      } ;;
    refs/heads/*)
      case "$1" in
        *[!0]*) ;;
        *) is_tracked "$2" && echo "1 majhi tracks \${2#refs/heads/} as the branch of $MAJHI_TASK, so it cannot be deleted or renamed." && return ;;
      esac
      is_own "$2" || echo "1 \${2#refs/heads/} is not a branch of $MAJHI_TASK. A run changes only its own branches (\${MAJHI_BRANCHES:-\${own#refs/heads/}}). The owner merges and pushes from Ship." ;;
    refs/bisect/* | refs/worktree/* | refs/rewritten/*) ;;
    refs/remotes/*)
      echo "1 $2 is majhi's copy of what the remote has. A run does not fetch, pull or move it; majhi fetches when it ships." ;;
    refs/stash)
      echo "1 the stash is shared by every checkout of this repo, the owner's too. Commit work in progress on your task branch instead of git stash." ;;
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*)
      echo "1 $2 is shared by every checkout of this repo, so a run may not change it." ;;
  esac
}
if [ "$name" = prepare-commit-msg ] && [ -n "$MAJHI_TASK" ] && [ "$MAJHI_TRAILER" = 1 ]; then
  git interpret-trailers --in-place --if-exists doNothing --trailer "${TASK_TRAILER}: $MAJHI_TASK" "$1" || exit 1
fi
if [ "$name" = reference-transaction ]; then
  input=$(cat)
  if [ "$1" = prepared ] && guarded; then
    if [ "$(git rev-parse --absolute-git-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)" ]; then
      why="a run changes git only inside its task's worktrees, not in the project's own checkout."
    else
      why=$(printf '%s\\n' "$input" | while read -r _old new ref; do refusal "$new" "$ref"; done | sort | head -n 1 | cut -c 3-)
    fi
    if [ -n "$why" ]; then
      echo "majhi: $why" >&2
      exit 1
    fi
  fi
fi
if [ "$name" = pre-push ] && guarded; then
  echo "majhi: a run does not push: its container has no sign-in to the host. Do not retry and do not ask to merge. Say in your final report that the work is done and the checks pass: majhi pushes and opens the merge request, or merges, by the workspace's rules." >&2
  exit 1
fi
if [ "$name" = post-checkout ] && [ "$3" = 1 ] && guarded; then
  head=$(git symbolic-ref -q HEAD)
  if [ -n "$head" ] && ! is_own "$head"; then
    git checkout --quiet - >/dev/null 2>&1
    echo "majhi: $(refusal "ref:$head" HEAD | cut -c 3-)" >&2
    exit 1
  fi
fi
repo_hooks=$(git config --local --get core.hooksPath)
[ -n "$repo_hooks" ] || repo_hooks="$(git rev-parse --git-common-dir)/hooks"
if [ "$name" = reference-transaction ]; then
  [ -x "$repo_hooks/$name" ] || exit 0
  printf '%s\\n' "$input" | "$repo_hooks/$name" "$@"
  exit $?
fi
if [ -x "$repo_hooks/$name" ]; then exec "$repo_hooks/$name" "$@"; fi
exit 0
`;

/**
 * Writes majhi's hooks under its home. Returns the folder, which a run mounts read-only. A script
 * is written only when it differs, and by rename, so a run executing one never reads half a file.
 */
export async function ensureHooks(majhiHome: string): Promise<string> {
  const dir = join(majhiHome, MAJHI_HOOKS_DIR);
  await mkdir(dir, { recursive: true });
  for (const name of HOOKS) {
    const path = join(dir, name);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === SCRIPT) continue;
    // Unique per write: two runs starting at once must not rename the same temporary file.
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, SCRIPT, { mode: 0o755 });
    await chmod(temp, 0o755);
    await rename(temp, path);
  }
  return dir;
}

/** Each repo's git folder, as given and with symlinks resolved, so the hooks match either form. */
async function gitDirsOf(repos: readonly { source?: string | undefined }[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const { source } of repos) {
    if (source === undefined) continue;
    const dir = join(source, ".git");
    dirs.add(dir);
    const real = await realpath(dir).catch(() => undefined);
    if (real !== undefined) dirs.add(real);
  }
  return [...dirs];
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
 * The git environment of one agent's run in a task: majhi's hooks and the task, always, so the run
 * stays on its own branches. With attribution off the org's identity is author and committer and
 * commits get no trailer, so they look as the owner's own.
 */
export async function gitAttribution(
  deps: { config: ConfigService; majhiHome: string },
  task: {
    id: string;
    org?: string | undefined;
    repos: readonly {
      project: string;
      branch?: string | undefined;
      source?: string | undefined;
      worktree?: string | undefined;
    }[];
  },
  agent: string,
): Promise<{ git: GitAttribution; hooks: string }> {
  const [author, on, hooks] = await Promise.all([
    orgIdentity(deps.config, task.org),
    attributionOf(deps.config, task),
    ensureHooks(deps.majhiHome),
  ]);
  const branches = task.repos.flatMap((r) => (r.branch === undefined ? [] : [r.branch]));
  // The run's git ignores package stores and caches, without any change to the repo's config.
  const excludesFile = await ensureWorktreeExcludes(task.repos.flatMap((r) => r.worktree ?? [])).catch(
    () => undefined,
  );
  const scope = {
    task: task.id,
    branches,
    gitDirs: await gitDirsOf(task.repos),
    hooks,
    ...(excludesFile === undefined ? {} : { excludesFile }),
  };
  if (!on.run) return { git: { author, committer: author, ...scope }, hooks };
  return { git: { author, committer: agentCommitter(agent), ...scope, trailer: true }, hooks };
}

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FULL } from "../captain/authority-fixtures.ts";
import { createChores } from "../captain/chores.ts";
import type { CaptainPorts, DeployPorts } from "../captain/ports.ts";
import { CaptainRepo } from "../captain/repo.ts";
import { ChoreRunner, type Workspace } from "../captain/runner.ts";
import { CaseDeployer } from "../cases/deploy.ts";
import { TaskDeploy } from "../cases/task-deploy.ts";
import { Store } from "../store/index.ts";
import { git, tempDir } from "../testing/fixtures.ts";
import { waitingDeployDecisions } from "./decisions.ts";
import { deployGit } from "./git.ts";
import { DeployPlanner } from "./plan.ts";
import { DeploySync, heldSteps } from "./sync.ts";
import { gitlabWorld, portsOf } from "./testing/gitlab-shop.ts";
import type { Rig } from "./testing/rig.ts";

/**
 * A deploy remote that has commits the source remote lacks, on real git repositories (a "GitHub" where work merges and a
 * "GitLab" where the project deploys, both bare folders) behind the fake GitLab. The owner's checkout has a stale or
 * diverged local main: it decides nothing.
 */

const NOW = () => new Date("2026-10-23T10:00:00.000Z");
let cleanup: (() => Promise<void>) | undefined;
let rigged: Rig | undefined;
afterEach(async () => {
  await rigged?.service.idle();
  await rigged?.hosts.close();
  rigged?.store.close();
  rigged = undefined;
  await cleanup?.();
});

const commit = async (cwd: string, file: string, text: string, message: string): Promise<string> => {
  await writeFile(join(cwd, file), text);
  await git(cwd, "add", file);
  await git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

interface Repos {
  dir: string;
  checkout: string;
  github: string;
  gitlab: string;
  /** The merge commit the task landed in on the source remote. */
  landed: string;
  /** The first commit, which the owner's local main is still at. */
  first: string;
  /** The newest commit only the deploy remote has. */
  gitlabTip: string;
}

/**
 * The task's fix merged on the source remote (`origin`). With `gitlabMoved`, the deploy remote (`gitlab`) has three
 * commits of its own, one of them on the same line as the task's fix. The owner's local main is left at the first
 * commit, and with `localDiverged` it also has a commit of its own.
 */
async function repos(opts: { gitlabMoved: boolean; localDiverged?: boolean }): Promise<Repos> {
  const t = await tempDir();
  cleanup = t.cleanup;
  const github = join(t.dir, "github.git");
  const gitlab = join(t.dir, "gitlab.git");
  const seed = join(t.dir, "seed");
  const checkout = join(t.dir, "checkout");
  for (const bare of [github, gitlab]) {
    await git(t.dir, "init", "--bare", "--quiet", "--initial-branch=main", bare);
  }
  await mkdir(seed);
  await git(seed, "init", "--quiet", "--initial-branch=main");
  const first = await commit(seed, "app.txt", "a\nb\nc\n", "first");
  await git(seed, "remote", "add", "origin", github);
  await git(seed, "remote", "add", "gitlab", gitlab);
  await git(seed, "push", "--quiet", "origin", "main");
  await git(seed, "push", "--quiet", "gitlab", "main");
  await git(t.dir, "clone", "--quiet", github, checkout);
  await git(checkout, "remote", "add", "gitlab", gitlab);

  let gitlabTip = first;
  if (opts.gitlabMoved) {
    await commit(seed, "app.txt", "a\nb gitlab\nc\n", "fix the slip total on GitLab");
    await commit(seed, "sync.txt", "1\n", "sync from GitHub");
    gitlabTip = await commit(seed, "notes.txt", "1\n", "add notes");
    await git(seed, "push", "--quiet", "gitlab", "main");
    await git(seed, "reset", "--quiet", "--hard", first);
  }

  // The task's fix merges on the source remote, on the same line GitLab changed.
  await git(seed, "checkout", "--quiet", "-b", "task/slips");
  await commit(seed, "app.txt", "a\nb task\nc\n", "print slips");
  await git(seed, "checkout", "--quiet", "main");
  await git(seed, "merge", "--quiet", "--no-ff", "-m", "Merge task/slips", "task/slips");
  const landed = await git(seed, "rev-parse", "HEAD");
  await git(seed, "push", "--quiet", "origin", "main");

  await git(checkout, "fetch", "--quiet", "origin");
  await git(checkout, "fetch", "--quiet", "gitlab");
  if (opts.localDiverged === true) await commit(checkout, "local.txt", "x\n", "the owner's own commit");
  return { dir: t.dir, checkout, github, gitlab, landed, first, gitlabTip };
}

const taskOf = (landed: string): Task =>
  ({
    id: "ACM-1",
    title: "Globex cannot print slips",
    status: "done",
    team: ["acme-builder"],
    repos: [
      {
        project: "storefront",
        branch: "task/slips",
        landed: { commit: landed, into: "main", at: "2026-10-23T09:00:00.000Z" },
      },
    ],
  }) as unknown as Task;

async function world(r: Repos): Promise<Rig> {
  const fetchAll = async (remotes: readonly string[]) => {
    for (const remote of remotes) await git(r.checkout, "fetch", "--quiet", remote);
  };
  rigged = await gitlabWorld({
    path: r.checkout,
    git: deployGit,
    refresh: async (_project, remotes) => {
      await fetchAll(remotes);
      return undefined;
    },
    // A real push, never forced: a deploy remote that has commits the commit lacks refuses it.
    push: async ({ remote, branch, commit: sha }) => {
      try {
        await git(r.checkout, "push", "--quiet", remote, `${sha}:refs/heads/${branch}`);
        return { ok: true };
      } catch (err) {
        return { ok: false, why: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  rigged.landed.clear();
  rigged.landed.add(r.landed);
  return rigged;
}

const plannerOf = (rig: Rig) =>
  new DeployPlanner({
    service: rig.service,
    repo: rig.store.deploys,
    ship: async () =>
      ({ steps: { deployStaging: "owner", deployProduction: "owner" }, rest: undefined, facts: {} }) as never,
    environments: async () => rig.project.environments,
  });

describe("a deploy remote that has commits the source lacks", () => {
  it("wakes the task's own agent in its own room, makes no task, and after the task lands again the push is a fast-forward", async () => {
    const repo = await repos({ gitlabMoved: true });
    const rig = await world(repo);
    const task = taskOf(repo.landed);
    await rig.service.plan({ task: "ACM-1", steps: [{ project: "storefront", env: "globex" }] }, "captain");
    const planner = plannerOf(rig);

    // Not a block: every target is being prepared, and the plan says why in plain words.
    const before = await planner.stepsOf(task);
    expect(before.map((s) => [s.env, s.state])).toEqual([
      ["globex", "preparing"],
      ["acme", "preparing"],
      ["initech", "preparing"],
    ]);
    expect(before[0]?.why).toContain("gitlab/main has 3 commits origin/main lacks");
    expect(waitingDeployDecisions([{ task: "ACM-1", steps: before }], () => undefined)).toEqual([]);

    // The captain's chore wakes the task's lead once, through the one wake a task's agent has.
    const woken: { task: string; text: string; by: string }[] = [];
    const lines: string[] = [];
    const tasks = {
      get: () => task,
      reopen: vi.fn(async () => task),
      send: vi.fn(async (input: { task: string; text: string; by: string }) => {
        woken.push(input);
      }),
      setStatusLines: vi.fn(async () => undefined),
      // Nothing in a deploy makes a task: this is the call that would.
      create: vi.fn(),
    };
    const sync = new DeploySync({
      tasks,
      refresh: async (_project, remotes) => {
        for (const remote of remotes) await git(repo.checkout, "fetch", "--quiet", remote);
        return undefined;
      },
      note: (_task, _key, _level, text) => void lines.push(text),
    });
    const deploys = {
      needsPlan: async () => undefined,
      next: async () => [],
      held: async () => heldSteps(task, await planner.stepsOf(task)),
      prepare: (_org: string, held: Parameters<DeployPorts["prepare"]>[1]) => sync.prepare(held),
      recheck: async () => undefined,
      deploy: async () => {
        throw new Error("nothing deploys while the deploy remote is ahead");
      },
    } as unknown as DeployPorts;
    const captainRepo = new CaptainRepo(new Store(":memory:").raw);
    const ws = (): Workspace => ({
      org: "acme",
      name: "Acme",
      mode: "on",
      authority: FULL,
      rules: {},
      tz: "UTC",
      day: "2026-10-23",
      rulesOff: new Set(),
    });
    const runner = new ChoreRunner({
      repo: captainRepo,
      now: NOW,
      workspace: async () => ws(),
      stopped: () => false,
      tellOwner: () => undefined,
      laneTokens: () => 0,
      chores: createChores(
        {
          typing: () => false,
          answerTasks: async () => [],
          reviewTasks: async () => [],
          deploys,
        } as unknown as CaptainPorts,
        NOW,
      ),
    });
    for (let pass = 0; pass < 2; pass++) {
      const started = await runner.startNow("acme", "ship");
      if (started.ran) await started.done;
    }
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({ task: "ACM-1", by: "majhi" });
    expect(woken[0]?.text).toContain("gitlab/main has 3 commits origin/main lacks");
    expect(woken[0]?.text).toContain("git merge gitlab/main");
    expect(woken[0]?.text).toContain("conflicts in app.txt");
    expect(tasks.reopen).toHaveBeenCalledTimes(1);
    expect(tasks.create).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(
      captainRepo
        .allActions()
        .filter((a) => a.outcome !== "skipped")
        .map((a) => [a.task, a.text]),
    ).toEqual([
      [
        "ACM-1",
        "Asked the lead of ACM-1 to bring gitlab/main into its branch so storefront globex can deploy: Globex cannot print slips",
      ],
    ]);

    // The agent merges gitlab/main into the task's branch, keeps both sides, and the task lands again.
    const worktree = join(repo.dir, "worktree");
    await git(repo.checkout, "worktree", "add", "--quiet", "-b", "task/slips-prep", worktree, "origin/main");
    await git(worktree, "merge", "--no-commit", "gitlab/main").catch(() => undefined);
    await commit(worktree, "app.txt", "a\nb task and gitlab\nc\n", "bring GitLab's commits in");
    await git(worktree, "push", "--quiet", "origin", "task/slips-prep");
    const seed = join(repo.dir, "seed");
    await git(seed, "fetch", "--quiet", "origin");
    await git(seed, "reset", "--quiet", "--hard", "origin/main");
    await git(seed, "merge", "--quiet", "--no-ff", "-m", "Merge task/slips-prep", "origin/task/slips-prep");
    const relanded = await git(seed, "rev-parse", "HEAD");
    await git(seed, "push", "--quiet", "origin", "main");
    // What completing the merge does: it reads the source remote's base again and records the landing.
    await git(repo.checkout, "fetch", "--quiet", "origin");
    rig.landed.add(relanded);
    const landedAgain = taskOf(relanded);
    landedAgain.status = "done";

    // One decision for the owner, and the commit is the merge that includes GitLab's three.
    const after = await planner.stepsOf(landedAgain);
    expect(after.map((s) => [s.env, s.state])).toEqual([
      ["globex", "waits-for-owner"],
      ["acme", "waits-for-previous"],
      ["initech", "waits-for-previous"],
    ]);
    expect(after[0]?.commit).toBe(relanded);
    const cards = waitingDeployDecisions([{ task: "ACM-1", steps: after }], () => ({
      title: task.title,
      updatedAt: "2026-10-23T09:00:00.000Z",
    }));
    expect(cards.map((c) => [c.id, c.options.map((o) => o.label)])).toEqual([
      ["deploy:ACM-1:storefront:globex", ["Deploy"]],
    ]);

    // The click pushes the merged commit to the deploy remote: a fast-forward over GitLab's own commits.
    const running: Promise<void>[] = [];
    const deployer = new CaseDeployer({
      ...portsOf(rig, ["backend/app/slips.py"]),
      land: async () => {
        throw new Error("a finished task lands nothing");
      },
      deploy: async (input, actor, hint) => {
        const out = await rig.service.deploy(input, actor, undefined, hint);
        taskDeploy.recorded(out.record);
        return out;
      },
    });
    const taskDeploy: TaskDeploy = new TaskDeploy({
      deployer,
      tasks: { get: () => landedAgain },
      hasRecipe: async (_project, env) =>
        rig.project.environments.find((e) => e.env === env)?.recipe !== undefined,
      repo: rig.store.deploys,
      note: () => undefined,
      background: (run) => void running.push(run()),
    });
    await taskDeploy.start("ACM-1", "owner");
    await Promise.all(running);

    expect(rig.published).toEqual([{ remote: "gitlab", commit: relanded, actor: "owner" }]);
    expect(await git(repo.gitlab, "rev-parse", "main")).toBe(relanded);
    // A fast-forward: GitLab's own newest commit is an ancestor of what it has now.
    await expect(git(repo.gitlab, "merge-base", "--is-ancestor", repo.gitlabTip, relanded)).resolves.toBe("");
    expect(rig.store.deploys.ofTask("ACM-1").map((d) => [d.env, d.state])).toEqual([
      ["globex", "live"],
      ["acme", "live"],
      ["initech", "live"],
    ]);
  });

  it("is not blocked by a stale or diverged main in the owner's checkout when the remotes agree", async () => {
    const repo = await repos({ gitlabMoved: false, localDiverged: true });
    const rig = await world(repo);
    const task = taskOf(repo.landed);
    await rig.service.plan({ task: "ACM-1", steps: [{ project: "storefront", env: "globex" }] }, "captain");

    // The local main is the first commit plus the owner's own: it has gone a different way from origin/main.
    expect(await git(repo.checkout, "rev-parse", "main")).not.toBe(repo.landed);
    const steps = await plannerOf(rig).stepsOf(task);
    // The head is what the source remote has, and GitLab only lacks it: the deploy pushes it first.
    expect(steps.map((s) => [s.env, s.state, s.commit])).toEqual([
      ["globex", "waits-for-owner", repo.landed],
      ["acme", "waits-for-previous", undefined],
      ["initech", "waits-for-previous", undefined],
    ]);
  });
});

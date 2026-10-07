import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { type FakeBitbucket, type FakeHosts, fakeBitbucket, fakeHosts } from "../testing/mrHosts.ts";
import { taskWorld, type World } from "../testing/world.ts";
import type { MrDeps } from "./service.ts";

/**
 * Push, open, watch and merge merge requests against local bare repos, with fake `gh`, `glab`
 * and Bitbucket. Nothing here reaches a real host.
 */

let w: World;
let fake: FakeHosts;
let bitbucket: FakeBitbucket | undefined;
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await w?.cleanup();
  await bitbucket?.close();
  bitbucket = undefined;
  for (const c of cleanups) await c();
  cleanups = [];
});

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 800; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const cmd = (name: string, body?: unknown) => w.h.cmd(name, body);
const get = async (id: string): Promise<Task> => (await cmd("tasks.get", { id })).body;
const notes = async (id: string) =>
  ((await cmd("room.items", { task: id, limit: 200 })).body.items as RoomItem[]).flatMap((i) =>
    i.type === "system" ? [i.text] : [],
  );
const secret = (name: string, value: string) => cmd("secrets.save", { name, value });
const must = (res: { status: number; body: unknown }) => {
  if (res.status !== 200) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

interface Setup {
  /** Merge is the captain's in acme and Autonomous is On, so the poller merges what is green. */
  captain?: boolean;
  /** Host of the web project. Default gitlab. */
  webHost?: "gitlab" | "bitbucket";
}

/**
 * An acme org with two projects: `acme-api` on GitHub and `acme-web` on GitLab (or Bitbucket),
 * where web depends on api. A task ACM-1 changed both and is in review with a commit in each.
 */
async function reviewed(setup: Setup = {}) {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  fake = await fakeHosts(join(t.dir, "bin"));
  const webHost = setup.webHost ?? "gitlab";
  if (webHost === "bitbucket") bitbucket = await fakeBitbucket("Bearer bb-token");
  w = await taskWorld({
    mrHosts: { bins: fake.bins, ...(bitbucket ? { bitbucket: { api: bitbucket.url } } : {}) },
  });
  await w.addRepo("web");
  must(await cmd("projects.register", { id: "acme-web", org: "acme", path: "~/Work/web", aliases: ["web"] }));
  must(
    await cmd("projects.update", {
      id: "acme-api",
      org: "acme",
      aliases: ["api"],
      remotes: { origin: { host: "github" } },
    }),
  );
  must(
    await cmd("projects.update", {
      id: "acme-web",
      org: "acme",
      aliases: ["web"],
      remotes: { origin: { host: webHost } },
      links: [{ to: "acme-api", type: "depends-on" }],
    }),
  );
  await fake.addRepo("remotes/api", w.remote("api"));
  await fake.addRepo("remotes/web", w.remote("web"));
  if (bitbucket) bitbucket.repos["remotes/web"] = w.remote("web");
  must(await secret("gh-acme", "gh-token-1"));
  must(await secret("gl-acme", "gl-token-1"));
  must(await secret("bb-acme", "bb-token"));
  must(
    await cmd("orgs.update", {
      id: "acme",
      mr_tokens: { github: "secret:gh-acme", gitlab: "secret:gl-acme", bitbucket: "secret:bb-acme" },
    }),
  );

  if (setup.captain === true) {
    // Who merges is the ship decision's, tested on its own; here the merge request mechanics run as if
    // it said the captain does.
    const deps = (w.h.majhi.services.mrs as unknown as { deps: MrDeps }).deps;
    deps.captainMerges = async () => ({ yes: true });
  }

  // "web" is named first, so the task lists web before api: the merge order must still put api first.
  const made = must(
    await cmd("tasks.create", {
      text: "add invoices to web and api",
      repos: [{ project: "acme-web" }, { project: "acme-api" }],
      start: true,
    }),
  ) as Task;
  await w.h.majhi.services.runs.idle();
  await until(async () => (await get(made.id)).status === "review", "review");
  expect(made.repos.map((r) => r.project)).toEqual(["acme-web", "acme-api"]);
  await commit(made.id, "acme-api", "invoice.txt");
  await commit(made.id, "acme-web", "invoices.html");
  return made.id;
}

async function commit(id: string, project: string, file: string): Promise<void> {
  const wt = join(w.taskDir(id), project);
  await writeFile(join(wt, file), `${file} from ${id}\n`);
  await git(wt, "add", ".");
  await git(wt, "commit", "--quiet", "-m", `Add ${file}`);
}

const mergeCalls = async () =>
  (await fake.state()).calls
    .filter((c) => c.args.includes("merge"))
    .map((c) => (c.args[0] === "pr" ? "api" : "web"));

describe("one task, two repos on two hosts", () => {
  it("opens two linked MRs, merges them in order, finishes the task and starts what waited on it", async () => {
    const id = await reviewed();
    // A second task waits until the first one's MRs are merged.
    const waiting = must(
      await cmd("tasks.create", {
        text: "tweak invoices in api",
        repos: [{ project: "acme-api" }],
        start: true,
        dependsOn: [id],
      }),
    ) as Task;
    expect(waiting.status).not.toBe("running");

    expect(await cmd("tasks.mergeOrder", { id })).toMatchObject({
      status: 200,
      body: { order: ["acme-api", "acme-web"], overridden: false },
    });

    // Push and open.
    const opened = await cmd("tasks.openMrs", { id });
    expect(opened.status).toBe(200);
    expect(opened.body.repos).toMatchObject([
      { project: "acme-api", outcome: "opened", url: "https://github.com/remotes/api/pull/1" },
      { project: "acme-web", outcome: "opened", url: "https://gitlab.com/remotes/web/-/merge_requests/1" },
    ]);
    const task = await get(id);
    expect(task.status).toBe("mr");
    for (const repo of task.repos) {
      expect(repo.pushedAt).toBeDefined();
      expect(repo.mr).toMatchObject({ number: 1, state: "open", ci: "none" });
      expect(await git(w.remote(repo.project === "acme-api" ? "api" : "web"), "rev-parse", repo.branch)).toBe(
        await git(join(w.taskDir(id), repo.project), "rev-parse", "HEAD"),
      );
    }

    // Both descriptions name the task and both MRs, api first, after all were open.
    const state = await fake.state();
    const github = state.prs["remotes/api"]?.[0]?.body ?? "";
    const gitlab = state.prs["remotes/web"]?.[0]?.body ?? "";
    for (const body of [github, gitlab]) {
      expect(body).toContain(`Task ${id}: add invoices to web and api`);
      expect(body).toContain("1. acme-api");
      expect(body).toContain("https://github.com/remotes/api/pull/1");
      expect(body).toContain("https://gitlab.com/remotes/web/-/merge_requests/1");
      expect(body.indexOf("acme-api")).toBeLessThan(body.indexOf("acme-web"));
    }
    expect(github).toContain("acme-api (this MR)");
    expect(gitlab).toContain("acme-web (this MR)");
    // The org's tokens, one per host, and not majhi's own.
    expect(state.calls.find((c) => c.bin === "gh")?.env).toEqual({ GH_TOKEN: "gh-token-1" });
    expect(state.calls.find((c) => c.bin === "glab")?.env).toEqual({ GITLAB_TOKEN: "gl-token-1" });

    // Merge: CI passes, the owner clicks.
    await fake.update((s) => {
      s.ci["remotes/api"] = "passing";
      s.ci["remotes/web"] = "passing";
    });
    const merged = await cmd("tasks.mergeMrs", { id });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ merged: ["acme-api", "acme-web"], done: true });
    expect(await mergeCalls()).toEqual(["api", "web"]);
    // One row per repo for the MR and for the merge on the host, with the MR link.
    expect(
      w.h.majhi.services.store.permissions.audit(id).map((r) => [r.kind, r.decision, r.by, r.org, r.detail]),
    ).toEqual([
      ["mr", "done", "owner", "acme", "https://github.com/remotes/api/pull/1"],
      ["mr", "done", "owner", "acme", "https://gitlab.com/remotes/web/-/merge_requests/1"],
      ["merge", "done", "owner", "acme", "https://github.com/remotes/api/pull/1"],
      ["merge", "done", "owner", "acme", "https://gitlab.com/remotes/web/-/merge_requests/1"],
    ]);
    expect(await git(w.remote("api"), "rev-parse", "main")).toBe(
      await git(w.remote("api"), "rev-parse", task.repos[1]?.branch ?? ""),
    );

    // The task is done and its worktrees are gone; the folder and the room stay.
    const done = await get(id);
    expect(done.status).toBe("done");
    for (const repo of done.repos) expect(repo.worktree).toBeUndefined();
    expect(existsSync(join(w.taskDir(id), "acme-api"))).toBe(false);
    expect(existsSync(join(w.taskDir(id), "acme-web"))).toBe(false);
    expect(existsSync(join(w.taskDir(id), "TASK.md"))).toBe(true);
    expect(await notes(id)).toContain("Every merge request is merged. The task is done.");

    // The waiting task started from the updated base.
    await until(
      async () => (await get(waiting.id)).status !== "ready" && (await get(waiting.id)).status !== "inbox",
      "waiting task started",
    );
    const started = await get(waiting.id);
    const wt = started.repos[0]?.worktree ?? "";
    expect(await readFile(join(wt, "invoice.txt"), "utf8")).toContain(`invoice.txt from ${id}`);
  });
});

describe("merge policies", () => {
  const passing = () =>
    fake.update((s) => {
      s.ci["remotes/api"] = "passing";
      s.ci["remotes/web"] = "passing";
    });
  const tick = () => w.h.majhi.services.mrPoller.tick();

  it("a click stops at the first failure, says why in the room, and continues on the next click", async () => {
    const id = await reviewed();
    must(await cmd("tasks.openMrs", { id }));
    await passing();
    await fake.update((s) => {
      s.mergeFails["remotes/web"] = "Merge conflict in invoices.html";
    });

    // The poller does not merge where Merge is the owner's, whatever the CI says.
    await tick();
    expect((await get(id)).repos.map((r) => r.mr?.state)).toEqual(["open", "open"]);

    const first = await cmd("tasks.mergeMrs", { id });
    expect(first.status).toBe(200);
    expect(first.body.merged).toEqual(["acme-api"]);
    expect(first.body.stoppedAt.project).toBe("acme-web");
    expect(first.body.stoppedAt.reason).toContain("Merge conflict in invoices.html");
    expect(first.body.done).toBe(false);
    expect((await get(id)).status).toBe("mr");
    expect((await notes(id)).some((n) => n.startsWith("Merging stopped at acme-web:"))).toBe(true);

    await fake.update((s) => {
      s.mergeFails = {};
    });
    const second = await cmd("tasks.mergeMrs", { id });
    expect(second.body).toMatchObject({ merged: ["acme-web"], done: true });
    expect((await get(id)).status).toBe("done");
  });

  it("does not merge past failing CI", async () => {
    const id = await reviewed();
    must(await cmd("tasks.openMrs", { id }));
    await fake.update((s) => {
      s.ci["remotes/api"] = "failing";
      s.ci["remotes/web"] = "passing";
    });
    const res = await cmd("tasks.mergeMrs", { id });
    expect(res.body.merged).toEqual([]);
    expect(res.body.stoppedAt).toMatchObject({ project: "acme-api" });
    expect(res.body.stoppedAt.reason).toContain("CI failed on acme-api");
    expect(await mergeCalls()).toEqual([]);
  });

  it("Merge is the captain's: the poller merges in order once CI passes, not before", async () => {
    const id = await reviewed({ captain: true });
    must(await cmd("tasks.openMrs", { id }));
    await fake.update((s) => {
      s.ci["remotes/api"] = "pending";
      s.ci["remotes/web"] = "passing";
    });
    await tick();
    expect(await mergeCalls()).toEqual([]);
    expect((await get(id)).repos.find((r) => r.project === "acme-api")?.mr?.ci).toBe("pending");

    await passing();
    await tick();
    expect(await mergeCalls()).toEqual(["api", "web"]);
    expect((await get(id)).status).toBe("done");
  });

  it("Merge is the owner's: the poller merges nothing, notices merges done on the host, and I merged it checks first", async () => {
    const id = await reviewed();
    must(await cmd("tasks.openMrs", { id }));
    await passing();
    await tick();
    expect(await mergeCalls()).toEqual([]);

    // The owner says they merged, but the host disagrees.
    const early = await cmd("tasks.markMerged", { id });
    expect(early.status).toBe(200);
    expect(early.body.done).toBe(false);
    expect(early.body.stillOpen.map((s: { project: string }) => s.project).sort()).toEqual([
      "acme-api",
      "acme-web",
    ]);
    expect((await get(id)).status).toBe("mr");

    // Merge one on the host: the poller sees it. Then the other, and the poller finishes the task.
    await hostMerge("remotes/api", "task");
    await tick();
    expect((await get(id)).repos.map((r) => r.mr?.state).sort()).toEqual(["merged", "open"]);
    expect((await get(id)).status).toBe("mr");
    await hostMerge("remotes/web", "task");
    await tick();
    expect((await get(id)).status).toBe("done");
  });

  it("force records the merge as the owner said", async () => {
    const id = await reviewed();
    must(await cmd("tasks.openMrs", { id }));
    const res = await cmd("tasks.markMerged", { id, force: true });
    expect(res.body).toMatchObject({ done: true, stillOpen: [] });
    expect((await get(id)).status).toBe("done");
    // The owner's word, not the host's: the row says so.
    const merges = w.h.majhi.services.store.permissions.audit(id).filter((r) => r.kind === "merge");
    expect(merges).toHaveLength(2);
    for (const row of merges) {
      expect(row).toMatchObject({
        decision: "done",
        by: "owner",
        detail: "recorded as merged by the owner, not checked with the host",
      });
    }
  });

  /** Merges the PR of a fake repo the way its host would: moves the base to the head. */
  async function hostMerge(slug: string, _label: string) {
    const state = await fake.state();
    const bare = state.repos[slug] as string;
    const pr = state.prs[slug]?.[0];
    if (pr === undefined) throw new Error(`no PR in ${slug}`);
    await git(
      bare,
      "update-ref",
      `refs/heads/${pr.base}`,
      await git(bare, "rev-parse", `refs/heads/${pr.head}`),
    );
    await fake.update((s) => {
      const p = s.prs[slug]?.[0];
      if (p) p.state = "MERGED";
    });
  }
});

describe("opening MRs", () => {
  it("refuses a worktree with uncommitted changes before pushing anything", async () => {
    const id = await reviewed();
    await writeFile(join(w.taskDir(id), "acme-api", "invoice.txt"), "changed again\n");
    const res = await cmd("tasks.openMrs", { id });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("acme-api has uncommitted changes");
    expect((await fake.state()).calls).toEqual([]);
    expect(existsSync(join(w.remote("web"), "refs", "heads", (await get(id)).repos[0]?.branch ?? "x"))).toBe(
      false,
    );
  });

  it("refuses a task that is not in review, and one with no commits at all", async () => {
    const id = await reviewed();
    await git(join(w.taskDir(id), "acme-web"), "reset", "--quiet", "--hard", "main");
    await git(join(w.taskDir(id), "acme-api"), "reset", "--quiet", "--hard", "main");
    const none = await cmd("tasks.openMrs", { id });
    expect(none.status).toBe(409);
    expect(none.body.error).toContain("No repo of this task has a commit to send");

    const inbox = must(
      await cmd("tasks.create", {
        text: "another change to api",
        repos: [{ project: "acme-api" }],
        start: false,
      }),
    ) as Task;
    const early = await cmd("tasks.openMrs", { id: inbox.id });
    expect(early.status).toBe(409);
    expect(early.body.error).toContain("Open merge requests from review");
  });
});

describe("credentials", () => {
  it("refuses before anything is pushed when a host has no token, for GitHub and GitLab too", async () => {
    const id = await reviewed();
    must(await cmd("orgs.update", { id: "acme", mr_tokens: { gitlab: "secret:gl-acme" } }));
    const res = await cmd("tasks.openMrs", { id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No github token is set for acme-api");
    expect((await fake.state()).calls).toEqual([]);
    expect(await git(w.remote("api"), "branch", "--list", "task/*")).toBe("");
    expect(await git(w.remote("web"), "branch", "--list", "task/*")).toBe("");

    must(await cmd("orgs.update", { id: "acme", mr_tokens: { github: "secret:gh-acme" } }));
    const gitlab = await cmd("tasks.openMrs", { id });
    expect(gitlab.body.error).toContain("No gitlab token is set for acme-web");
  });
});

describe("a task closed with merge requests not merged", () => {
  it("keeps what waits on it waiting, pauses it with a reason, and says when the merge happened", async () => {
    const id = await reviewed();
    const waiting = must(
      await cmd("tasks.create", {
        text: "tweak invoices in api",
        repos: [{ project: "acme-api" }],
        start: false,
        dependsOn: [id],
      }),
    ) as Task;
    must(await cmd("tasks.openMrs", { id }));

    // The owner closes the task while both MRs are open.
    must(await cmd("tasks.close", { id }));
    expect((await get(id)).status).toBe("done");
    const paused = await get(waiting.id);
    expect(paused).toMatchObject({ status: "paused", pausedReason: "blocked" });
    expect(
      (await notes(waiting.id)).some((n) =>
        n.includes(`${id} was closed, but its merge requests are not merged`),
      ),
    ).toBe(true);
    const listed = (await cmd("tasks.list", {})).body.find((t: { id: string }) => t.id === waiting.id);
    expect(listed.waitingOn).toEqual([id]);
    expect((await cmd("tasks.start", { id: waiting.id })).status).toBe(409);

    // One merged on the host is not enough.
    const hostMerge = async (slug: string) => {
      const state = await fake.state();
      const bare = state.repos[slug] as string;
      const pr = state.prs[slug]?.[0];
      if (pr === undefined) throw new Error("no PR");
      await git(
        bare,
        "update-ref",
        `refs/heads/${pr.base}`,
        await git(bare, "rev-parse", `refs/heads/${pr.head}`),
      );
      await fake.update((s) => {
        const p = s.prs[slug]?.[0];
        if (p) p.state = "MERGED";
      });
    };
    await hostMerge("remotes/api");
    await w.h.majhi.services.mrPoller.tick();
    expect(
      (await cmd("tasks.list", {})).body.find((t: { id: string }) => t.id === waiting.id).waitingOn,
    ).toEqual([id]);

    // Both merged: the dependency is met, the owner is told, and the task can start.
    await hostMerge("remotes/web");
    await w.h.majhi.services.mrPoller.tick();
    expect(
      (await cmd("tasks.list", {})).body.find((t: { id: string }) => t.id === waiting.id).waitingOn,
    ).toEqual([]);
    expect(
      (await notes(waiting.id)).some((n) => n.includes(`Every merge request of ${id} is merged now`)),
    ).toBe(true);
    expect((await cmd("tasks.start", { id: waiting.id })).status).toBe(200);
  });
});

describe("after the merge", () => {
  it("keeps a worktree with uncommitted changes and still finishes the task", async () => {
    const id = await reviewed();
    must(await cmd("tasks.openMrs", { id }));
    await fake.update((s) => {
      s.ci["remotes/api"] = "passing";
      s.ci["remotes/web"] = "passing";
    });
    const wt = join(w.taskDir(id), "acme-web");
    await writeFile(join(wt, "scratch.txt"), "not committed\n");
    const res = await cmd("tasks.mergeMrs", { id });
    expect(res.body.done).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(w.taskDir(id), "acme-api"))).toBe(false);
    const done = await get(id);
    expect(done.repos.find((r) => r.project === "acme-web")?.worktree).toBe(wt);
    expect(
      (await notes(id)).some((n) => n.includes("kept the worktree") && n.includes("uncommitted changes")),
    ).toBe(true);
  });
});

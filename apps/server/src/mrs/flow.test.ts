import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { type FakeBitbucket, type FakeHosts, fakeBitbucket, fakeHosts } from "../testing/mrHosts.ts";
import { until } from "../testing/until.ts";
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
      id: "acme-web",
      org: "acme",
      aliases: ["web"],
      links: [{ to: "acme-api", type: "depends-on" }],
    }),
  );
  // The remotes are local folders, which name no host: say which host each one is.
  const deps = (w.h.majhi.services.mrs as unknown as { deps: MrDeps }).deps;
  deps.hostOf = (url) => (url === w.remote("api") ? "github" : webHost);
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

describe("who merges", () => {
  const passing = () =>
    fake.update((s) => {
      s.ci["remotes/api"] = "passing";
      s.ci["remotes/web"] = "passing";
    });
  const tick = () => w.h.majhi.services.mrPoller.tick();

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

  it("a failing pipeline is said once in the room and waits in Needs you with Fix with agent", async () => {
    const id = await reviewed();
    must(await cmd("tasks.openMrs", { id }));
    await fake.update((s) => {
      s.ci["remotes/api"] = "failing";
      s.ci["remotes/web"] = "passing";
    });
    await tick();
    await tick();
    const said = (await notes(id)).filter((t) => t.includes("checks of the merge request failed"));
    expect(said).toHaveLength(1);
    const decisions = must(await cmd("decisions.list", {})) as {
      decisions: { id: string; options: { id: string }[] }[];
    };
    const mine = decisions.decisions.find((d) => d.id === `mrci:${id}`);
    expect(mine?.options.map((o) => o.id)).toEqual(["fix"]);
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

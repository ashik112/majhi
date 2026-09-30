import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** Ship's pushes against a local bare remote: never forced, and refused with the fix when they cannot work. */

let w: World;
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await w?.cleanup();
  for (const c of cleanups) await c();
  cleanups = [];
});

const cmd = (name: string, body?: unknown) => w.h.cmd(name, body);
const branch = "task/acm-1-fix-api";
const tip = (repo: string, ref: string) => git(repo, "rev-parse", ref).then((s) => s.trim());

/** ACM-1 on api, in review, with one committed change on its branch. */
async function reviewed(): Promise<void> {
  w = await taskWorld();
  w.h.runtime.onSession = (session) => {
    session.script = async (t) => {
      await writeFile(join(w.taskDir("ACM-1"), "acme-api", "fix.txt"), "fix\n");
      t.emit({ type: "text", messageId: "m", text: "Done." });
      return "end_turn";
    };
  };
  expect((await cmd("tasks.create", { text: "fix api", start: true })).status).toBe(200);
  await w.h.majhi.services.runs.idle();
  expect((await cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("review");
}

/** Someone else pushes a commit to `ref` on the remote. */
async function pushFromElsewhere(ref: string): Promise<string> {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  const clone = join(t.dir, "other");
  await git(t.dir, "clone", "--quiet", w.remote("api"), clone);
  await git(clone, "checkout", "--quiet", "-B", ref, `origin/${ref}`);
  await writeFile(join(clone, "other.txt"), "other\n");
  await git(clone, "add", ".");
  await git(
    clone,
    "-c",
    "user.name=Other",
    "-c",
    "user.email=other@example.com",
    "commit",
    "--quiet",
    "-m",
    "other",
  );
  await git(clone, "push", "--quiet", "origin", `${ref}:${ref}`);
  return tip(clone, "HEAD");
}

describe("Ship", () => {
  it("merges into main and pushes main, then marks the task done", async () => {
    await reviewed();
    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([{ project: "acme-api", into: "main", ok: true }]);
    expect(res.body.task.status).toBe("done");
    expect(await tip(w.remote("api"), "main")).toBe(await tip(w.repo("api"), "main"));
    expect(await git(w.remote("api"), "ls-tree", "--name-only", "main")).toContain("fix.txt");
  });

  it("refuses to merge and push when the remote branch moved, and changes nothing", async () => {
    await reviewed();
    const theirs = await pushFromElsewhere("main");
    const before = await tip(w.repo("api"), "main");
    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      "origin/main has commits that your local main in acme-api does not have. majhi never force-pushes: bring main up to date first, then ship again.",
    );
    // Nothing merged locally, nothing overwritten on the remote.
    expect(await tip(w.repo("api"), "main")).toBe(before);
    expect(await tip(w.remote("api"), "main")).toBe(theirs);
    expect((await cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("review");
  });

  it("pushes the task branch, and never forces over a branch that moved on the remote", async () => {
    await reviewed();
    const first = await cmd("tasks.push", { id: "ACM-1" });
    expect(first.status).toBe(200);
    expect(first.body.results).toMatchObject([{ project: "acme-api", into: branch, ok: true }]);
    expect(await tip(w.remote("api"), branch)).toBe(await tip(w.repo("api"), branch));

    const theirs = await pushFromElsewhere(branch);
    const second = await cmd("tasks.push", { id: "ACM-1" });
    expect(second.status).toBe(200);
    expect(second.body.results[0]).toMatchObject({ ok: false });
    expect(second.body.results[0].detail).toContain("majhi never force-pushes");
    expect(await tip(w.remote("api"), branch)).toBe(theirs);
  });

  it("says why an action cannot work and where to fix it", async () => {
    await reviewed();
    let options = (await cmd("tasks.shipOptions", { id: "ACM-1" })).body;
    expect(options).toMatchObject({
      base: "main",
      merge: { ok: true },
      mergePush: { ok: true },
      push: { ok: true },
    });
    // No host known for a local path remote.
    expect(options.mr.ok).toBe(false);

    await cmd("projects.update", {
      id: "acme-api",
      org: "acme",
      aliases: ["api"],
      remotes: { origin: { host: "github" } },
    });
    options = (await cmd("tasks.shipOptions", { id: "ACM-1" })).body;
    expect(options.host).toBe("github");
    expect(options.mr).toEqual({ ok: false, why: "No GitHub token: add one in Orgs > Acme." });

    // An https remote without an SSH alias: nothing can be pushed.
    await git(w.repo("api"), "remote", "set-url", "origin", "https://github.com/acme/api.git");
    options = (await cmd("tasks.shipOptions", { id: "ACM-1" })).body;
    const why =
      "No SSH alias for acme-api's origin remote, and majhi pushes over SSH, not https. Pick an alias for it in Projects.";
    expect(options.push).toEqual({ ok: false, why });
    expect(options.mergePush).toEqual({ ok: false, why });
    expect(options.merge).toEqual({ ok: true });
    const refused = await cmd("tasks.push", { id: "ACM-1" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(why);

    // With an alias the push goes over SSH.
    await cmd("projects.update", {
      id: "acme-api",
      org: "acme",
      aliases: ["api"],
      remotes: { origin: { host: "github", ssh: "github-acme" } },
    });
    expect((await cmd("tasks.shipOptions", { id: "ACM-1" })).body.push).toEqual({ ok: true });
  });
});

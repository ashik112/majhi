import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** Fetching a project's branch from its remote with no task: the tracking ref moves, the local branch only fast-forwards. */

let w: World;
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await w?.cleanup();
  for (const c of cleanups) await c();
  cleanups = [];
});

const cmd = (name: string, body?: unknown, meta?: unknown) => w.h.cmd(name, body, meta);
const tip = (repo: string, ref: string) => git(repo, "rev-parse", ref).then((s) => s.trim());
const AGENT = { actor: { kind: "agent", id: "acme-builder" }, reason: "to read the latest code" };
const commitAs = (repo: string, msg: string) =>
  git(repo, "-c", "user.name=Other", "-c", "user.email=other@example.com", "commit", "--quiet", "-m", msg);

/** Someone else pushes `file` to main on the remote of `name`. */
async function pushFromElsewhere(name: string, file: string): Promise<string> {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  const clone = join(t.dir, "other");
  await git(t.dir, "clone", "--quiet", w.remote(name), clone);
  await mkdir(join(clone, file, ".."), { recursive: true });
  await writeFile(join(clone, file), "other\n");
  await git(clone, "add", ".");
  await commitAs(clone, "other");
  await git(clone, "push", "--quiet", "origin", "main:main");
  return tip(clone, "HEAD");
}

describe("projects.fetch", () => {
  it("still moves origin/main when local main has its own commits, and leaves main as it was", async () => {
    w = await taskWorld();
    await writeFile(join(w.repo("api"), "mine.txt"), "mine\n");
    await git(w.repo("api"), "add", "mine.txt");
    await commitAs(w.repo("api"), "mine");
    const mine = await tip(w.repo("api"), "main");
    const theirs = await pushFromElsewhere("api", "other.txt");

    const res = await cmd("projects.fetch", { project: "acme-api" }, AGENT);
    expect(res.status).toBe(200);
    expect(res.body.to).toBe(theirs);
    expect(res.body.local).toMatchObject({ ok: false });
    expect(await tip(w.repo("api"), "refs/remotes/origin/main")).toBe(theirs);
    expect(await tip(w.repo("api"), "main")).toBe(mine);
  });

  it("refuses an org agent another org's project and fetches nothing", async () => {
    w = await taskWorld();
    expect((await cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" })).status).toBe(200);
    await w.addRepo("web");
    expect(
      (await cmd("projects.register", { id: "globex-web", org: "globex", path: "~/Work/web" })).status,
    ).toBe(200);
    const before = await tip(w.repo("web"), "refs/remotes/origin/main");
    await pushFromElsewhere("web", "other.txt");

    const res = await cmd("projects.fetch", { project: "globex-web" }, AGENT);
    expect(res.status).toBe(409);
    expect(await tip(w.repo("web"), "refs/remotes/origin/main")).toBe(before);

    // The owner may fetch any project.
    expect((await cmd("projects.fetch", { project: "globex-web" })).status).toBe(200);
  });
});

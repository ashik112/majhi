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
  expect(
    (await cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true })).status,
  ).toBe(200);
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
  it("refuses to merge and push when the remote branch moved, and changes nothing", async () => {
    await reviewed();
    const theirs = await pushFromElsewhere("main");
    const before = await tip(w.repo("api"), "main");
    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(res.status).toBe(409);
    // Nothing merged locally, nothing overwritten on the remote.
    expect(await tip(w.repo("api"), "main")).toBe(before);
    expect(await tip(w.remote("api"), "main")).toBe(theirs);
    expect((await cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("review");
  });
});

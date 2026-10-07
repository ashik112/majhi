import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** Updating the owner's local target branch from its remote: only a pure fast-forward, never forced. */

let w: World;
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await w?.cleanup();
  for (const c of cleanups) await c();
  cleanups = [];
});

const cmd = (name: string, body?: unknown) => w.h.cmd(name, body);
const tip = (repo: string, ref: string) => git(repo, "rev-parse", ref).then((s) => s.trim());
const commitAs = (repo: string, msg: string) =>
  git(repo, "-c", "user.name=Other", "-c", "user.email=other@example.com", "commit", "--quiet", "-m", msg);

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

/** Someone else pushes `file` to main on the remote. */
async function pushFromElsewhere(file: string, content = "other\n"): Promise<string> {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  const clone = join(t.dir, "other");
  await git(t.dir, "clone", "--quiet", w.remote("api"), clone);
  await mkdir(join(clone, file, ".."), { recursive: true });
  await writeFile(join(clone, file), content);
  await git(clone, "add", ".");
  await commitAs(clone, "other");
  await git(clone, "push", "--quiet", "origin", "main:main");
  return tip(clone, "HEAD");
}

describe("tasks.updateTarget", () => {
  it("refuses when the local branch has commits the remote lacks", async () => {
    await reviewed();
    await pushFromElsewhere("other.txt");
    for (const n of ["a", "b"]) {
      await writeFile(join(w.repo("api"), `${n}.txt`), n);
      await git(w.repo("api"), "add", ".");
      await commitAs(w.repo("api"), n);
    }
    const before = await tip(w.repo("api"), "main");
    const res = await cmd("tasks.updateTarget", { id: "ACM-1", into: "main" });
    expect(res.body.results[0]).toMatchObject({ ok: false });
    expect(await tip(w.repo("api"), "main")).toBe(before);
  });

  it("refuses when an incoming file has uncommitted edits, and changes nothing", async () => {
    await reviewed();
    await pushFromElsewhere("README.md", "theirs\n");
    await writeFile(join(w.repo("api"), "README.md"), "my edit\n");
    const before = await tip(w.repo("api"), "main");
    const res = await cmd("tasks.updateTarget", { id: "ACM-1", into: "main" });
    expect(res.body.results[0].ok).toBe(false);
    expect(await tip(w.repo("api"), "main")).toBe(before);
    expect(await readFile(join(w.repo("api"), "README.md"), "utf8")).toBe("my edit\n");
  });

  it("refuses when an untracked path is in the way of an incoming file", async () => {
    await reviewed();
    await pushFromElsewhere("docs/guide.txt");
    await writeFile(join(w.repo("api"), "docs"), "a file where a folder must go\n");
    const before = await tip(w.repo("api"), "main");
    const res = await cmd("tasks.updateTarget", { id: "ACM-1", into: "main" });
    expect(res.body.results[0].ok).toBe(false);
    expect(await tip(w.repo("api"), "main")).toBe(before);
  });
});

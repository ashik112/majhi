import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** Every push, merge and the push after a merge leaves one audit row per repo, from whichever way it was asked for. */

let w: World;
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await w?.cleanup();
  for (const c of cleanups) await c();
  cleanups = [];
});

const cmd = (name: string, body?: unknown) => w.h.cmd(name, body);
const audit = () => w.h.majhi.services.store.permissions.audit("ACM-1");
const branch = "fix/acm-1-fix-api";

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
async function pushFromElsewhere(ref: string): Promise<void> {
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
}

describe("Audit of ships", () => {
  it("logs a push that worked, and one that was refused, with the branch or the error", async () => {
    await reviewed();
    expect((await cmd("tasks.push", { id: "ACM-1" })).status).toBe(200);
    await pushFromElsewhere(branch);
    expect((await cmd("tasks.push", { id: "ACM-1" })).status).toBe(200);

    const rows = audit().filter((r) => r.kind === "push");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      decision: "done",
      by: "owner",
      agent: "owner",
      org: "acme",
      title: "Push of acme-api",
      detail: `origin/${branch}`,
    });
    expect(rows[1]).toMatchObject({ decision: "failed", by: "owner" });
    expect(rows[1]?.detail).toContain("majhi never force-pushes");
  });

  it("logs a merge that worked, then merge and push as two rows", async () => {
    await reviewed();
    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(res.status).toBe(200);
    expect(audit().map((r) => [r.kind, r.decision, r.detail])).toEqual([
      ["merge", "done", "main"],
      ["merge+push", "done", "origin/main"],
    ]);
  });

  it("logs a merge that was refused, with the reason", async () => {
    await reviewed();
    await writeFile(join(w.taskDir("ACM-1"), "acme-api", "fix.txt"), "changed again\n");
    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", done: true });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([{ ok: false }]);
    expect(audit()).toMatchObject([
      {
        kind: "merge",
        decision: "failed",
        by: "owner",
        detail: expect.stringContaining("uncommitted changes"),
      },
    ]);
  });

  it("writes nothing when the ship is refused before anything runs", async () => {
    await reviewed();
    await pushFromElsewhere("main");
    expect((await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true })).status).toBe(
      409,
    );
    expect(audit()).toEqual([]);
  });

  it("lists them across tasks through audit.list, newest first, and refuses a bad date", async () => {
    await reviewed();
    await cmd("tasks.push", { id: "ACM-1" });
    await cmd("tasks.merge", { id: "ACM-1", into: "main", done: true });
    const res = await cmd("audit.list", { org: "acme", kinds: ["push", "merge"], limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.entries).toMatchObject([{ kind: "merge", task: "ACM-1", org: "acme" }]);
    expect(res.body.next).toBe(res.body.entries[0].id);
    expect(res.body.kinds).toEqual(["merge", "push"]);
    expect((await cmd("audit.list", { from: "yesterday-ish" })).status).toBe(400);
  });
});

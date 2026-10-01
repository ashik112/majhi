import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const AGENT = { actor: { kind: "agent", id: "acme-builder" }, reason: "the subtask is reviewed" };
const idle = () => w.h.majhi.services.runs.idle();
const task = async () => (await w.h.cmd("tasks.get", { id: "ACM-1" })).body as Task;
const reviewCard = async () =>
  ((await w.h.cmd("room.items", { task: "ACM-1", limit: 200 })).body.items as RoomItem[]).find(
    (i): i is Extract<RoomItem, { type: "review" }> => i.type === "review",
  );

/** ACM-1 in review. With `write`, the agent commits one file on the task branch. */
async function reviewTask(write: boolean): Promise<string> {
  w.h.runtime.onSession = (session) => {
    session.script = async (t) => {
      if (write) await writeFile(join(w.taskDir("ACM-1"), "acme-api", "work.txt"), "work\n");
      t.emit({ type: "text", messageId: "m", text: "Done." });
      return "end_turn";
    };
  };
  expect((await w.h.cmd("tasks.create", { text: "fix api", start: true })).status).toBe(200);
  await idle();
  const t = await task();
  expect(t.status).toBe("review");
  return t.repos[0]?.branch ?? "";
}

describe("closing a task with work not shipped", () => {
  it("refuses the owner with what is unshipped, and closes once the owner confirms", async () => {
    w = await taskWorld();
    const branch = await reviewTask(true);
    const expected = `acme-api: 1 commit on ${branch} is not merged, pushed or in a pull request.`;

    const options = await w.h.cmd("tasks.shipOptions", { id: "ACM-1" });
    expect(options.body.done).toEqual({ ok: true, unshipped: [{ project: "acme-api", branch, commits: 1 }] });

    const refused = await w.h.cmd("tasks.close", { id: "ACM-1" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(`${expected} Close it anyway to leave the commits on the branch.`);
    expect((await task()).status).toBe("review");

    const kept = await w.h.cmd("tasks.close", { id: "ACM-1", unshipped: "keep" });
    expect(kept.status).toBe(200);
    expect((await task()).status).toBe("done");
    expect((await reviewCard())?.state).toBe("settled");
    expect((await reviewCard())?.outcome).toMatchObject({ text: "Marked done", by: "owner" });
    // The commits stay on the branch.
    expect(await git(w.repo("api"), "ls-tree", "--name-only", branch)).toContain("work.txt");
  });

  it("asks the same of the review card's Mark done", async () => {
    w = await taskWorld();
    await reviewTask(true);
    const card = await reviewCard();
    const act = (extra: object) =>
      w.h.cmd("room.cardAction", { task: "ACM-1", item: card?.id, action: "done", ...extra });
    expect((await act({})).status).toBe(409);
    expect((await act({ unshipped: "keep" })).status).toBe(200);
    expect((await task()).status).toBe("done");
  });

  it("refuses an agent whatever it passes, and tells it how to ship", async () => {
    w = await taskWorld();
    await reviewTask(true);
    for (const input of [{ id: "ACM-1" }, { id: "ACM-1", unshipped: "keep" }]) {
      const refused = await w.h.cmd("tasks.close", input, AGENT);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain("ACM-1 cannot be closed yet.");
      expect(refused.body.error).toContain("Merge permission");
    }
    const card = await reviewCard();
    const viaCard = await w.h.cmd(
      "room.cardAction",
      { task: "ACM-1", item: card?.id, action: "done", unshipped: "keep" },
      AGENT,
    );
    expect(viaCard.status).toBe(409);
    expect((await task()).status).toBe("review");
  });

  it("records the agent that closes a task with nothing to ship", async () => {
    w = await taskWorld();
    await reviewTask(false);
    expect((await w.h.cmd("tasks.close", { id: "ACM-1" }, AGENT)).status).toBe(200);
    expect((await task()).status).toBe("done");
    expect((await reviewCard())?.outcome).toMatchObject({ text: "Marked done", by: "acme-builder" });
  });
});

describe("work counts as shipped", () => {
  it("when the branch is merged into its base, even squashed", async () => {
    w = await taskWorld();
    const branch = await reviewTask(true);
    // Two commits squashed into one: no single commit of the base matches either.
    const tree = join(w.taskDir("ACM-1"), "acme-api");
    await writeFile(join(tree, "more.txt"), "more\n");
    await git(tree, "add", ".");
    await git(tree, "commit", "--quiet", "-m", "more");
    const repo = w.repo("api");
    await git(repo, "merge", "--squash", branch);
    await git(repo, "commit", "--quiet", "-m", "squashed");
    expect((await w.h.cmd("tasks.shipOptions", { id: "ACM-1" })).body.done).toEqual({ ok: true });
    expect((await w.h.cmd("tasks.close", { id: "ACM-1" }, AGENT)).status).toBe(200);
  });

  it("when the branch is cherry-picked into its base", async () => {
    w = await taskWorld();
    const branch = await reviewTask(true);
    await git(w.repo("api"), "cherry-pick", branch);
    expect((await w.h.cmd("tasks.close", { id: "ACM-1" })).status).toBe(200);
  });

  it("when the remote has the branch's head, and not after a later commit", async () => {
    w = await taskWorld();
    const branch = await reviewTask(true);
    const repo = w.repo("api");
    await git(repo, "push", "--quiet", "origin", branch);
    expect((await w.h.cmd("tasks.shipOptions", { id: "ACM-1" })).body.done).toEqual({ ok: true });

    await writeFile(join(w.taskDir("ACM-1"), "acme-api", "more.txt"), "more\n");
    await git(join(w.taskDir("ACM-1"), "acme-api"), "add", ".");
    await git(join(w.taskDir("ACM-1"), "acme-api"), "commit", "--quiet", "-m", "more");
    expect((await w.h.cmd("tasks.close", { id: "ACM-1" }, AGENT)).status).toBe(409);
  });

  it("when majhi pushed it to a URL and nothing was committed since", async () => {
    w = await taskWorld();
    const branch = await reviewTask(true);
    // A push to a URL leaves no remote-tracking ref: majhi's own record of the push says it.
    await git(w.repo("api"), "push", "--quiet", w.remote("api"), branch);
    const { store } = w.h.majhi.services;
    store.tasks.setPushed("ACM-1", "acme-api", new Date(Date.now() + 2_000).toISOString());
    expect((await w.h.cmd("tasks.shipOptions", { id: "ACM-1" })).body.done).toEqual({ ok: true });

    vi.stubEnv("GIT_COMMITTER_DATE", new Date(Date.now() + 60_000).toISOString());
    const tree = join(w.taskDir("ACM-1"), "acme-api");
    await writeFile(join(tree, "more.txt"), "more\n");
    await git(tree, "add", ".");
    await git(tree, "commit", "--quiet", "-m", "more");
    expect((await w.h.cmd("tasks.close", { id: "ACM-1" })).status).toBe(409);
  });

  it("when its merge request is open", async () => {
    w = await taskWorld();
    await reviewTask(true);
    w.h.majhi.services.store.tasks.setMr("ACM-1", "acme-api", {
      url: "https://git.example.com/acme/api/pull/1",
      number: 1,
      state: "open",
      ci: "pending",
    });
    expect((await w.h.cmd("tasks.close", { id: "ACM-1" }, AGENT)).status).toBe(200);
  });
});

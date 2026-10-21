import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const OWNER = { id: "acct-owner", label: "owner@acme.test" };
const STRANGER = { id: "acct-stranger", label: "sam@globex.test" };

async function startTask(text: string) {
  const res = await w.h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: true });
  expect(res.status).toBe(200);
}

describe("the sign-in file shared by an account's workspaces", () => {
  it("refuses the next session when a changed file belongs to someone else and asks to sign in again, and lets a refreshed file of the same person through", async () => {
    w = await taskWorld();
    const { h } = w;
    const folder = join(h.env.majhiHome, "accounts", "claude-acme");
    const signIn = join(folder, ".credentials.json");
    await mkdir(folder, { recursive: true });

    // The owner signs in: the account is pinned to them.
    await writeFile(signIn, '{"token":"one"}');
    h.runtime.identity = OWNER;
    // A usage read that works is what proves a sign-in to the health check, as with a real CLI.
    h.runtime.usage = { models: [], estimated: false, updatedAt: "2026-01-01T00:00:00.000Z" };
    expect((await h.cmd("accounts.health", { id: "claude-acme" })).body.health.ok).toBe(true);
    expect(h.runtime.identityReads).toHaveLength(1);

    // The CLI refreshed its token: the file is new, the person is the same. The session starts.
    await writeFile(signIn, '{"token":"two"}');
    await startTask("first");
    await until(() => h.runtime.starts.length === 1, "the first session");
    expect(h.runtime.identityReads).toHaveLength(2);
    // Next to majhi nothing is isolated: the session keeps the account folder as its home.
    expect(h.runtime.starts[0]?.account).toMatchObject({ home: folder });
    expect(h.runtime.starts[0]?.account.accountHome).toBeUndefined();

    // An agent swapped the file for another person's. No session starts on it.
    await writeFile(signIn, '{"token":"three, someone else"}');
    h.runtime.identity = STRANGER;
    await startTask("second");
    await until(async () => {
      const accounts = (await h.cmd("accounts.list")).body as { id: string; status: string }[];
      return accounts.find((a) => a.id === "claude-acme")?.status === "needs-login";
    }, "the account to need a sign-in");
    expect(h.runtime.starts).toHaveLength(1);

    // Needs you shows the existing sign-in item, with the reason.
    const { decisions } = await h.majhi.services.inbox.view();
    const item = decisions.find((d) => d.kind === "sign-in");
    expect(item?.title).toContain("Sign in claude-acme");
    expect(item?.sentence).toContain("sam@globex.test");
    expect(item?.sentence).toContain("owner@acme.test");

    // The same file is refused again without reading it again, also by a health check.
    const reads = h.runtime.identityReads.length;
    expect((await h.majhi.services.accounts.health("claude-acme", true)).health.ok).toBe(false);
    expect(h.runtime.identityReads).toHaveLength(reads);

    // The owner signs in again as themselves: the account passes.
    await writeFile(signIn, '{"token":"four"}');
    h.runtime.identity = OWNER;
    expect((await h.majhi.services.accounts.health("claude-acme", true)).health.ok).toBe(true);
  });
});

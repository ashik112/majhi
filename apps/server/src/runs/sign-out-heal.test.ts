import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const DEAD = "Failed to authenticate: OAuth session expired and could not be refreshed";

describe("a run that loses its sign-in mid-run", () => {
  it("resumes once when the account checks fine (another session refreshed it), and a second sign-out on the same sign-in is a real one", async () => {
    w = await taskWorld();
    const { h } = w;
    const folder = join(h.env.majhiHome, "accounts", "claude-acme");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, ".credentials.json"), '{"token":"refreshed by the other session"}');
    // The account reads fine: it is signed in as its owner and a usage read works.
    h.runtime.usage = { models: [], estimated: false, updatedAt: "2026-01-01T00:00:00.000Z" };
    // Every turn fails on the sign-in the session held.
    h.runtime.onSession = (session) => {
      session.script = async () => {
        throw new Error(DEAD);
      };
    };
    const res = await h.cmd("tasks.create", {
      text: "fix api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    expect(res.status).toBe(200);

    // First sign-out: the check is fine, so the run starts a new session and tries the prompt again.
    // Second sign-out on the same file: no more of that, the existing signed-out path runs.
    await until(
      () => h.majhi.services.store.tasks.get("ACM-1")?.pausedReason === "signed-out",
      "the task to pause as signed out",
    );
    expect(h.runtime.starts).toHaveLength(2);

    h.majhi.services.room.flush("ACM-1");
    const items = (await h.cmd("room.items", { task: "ACM-1", limit: 200 })).body.items as RoomItem[];
    const lines = items.flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(lines.filter((t) => t === "The sign-in was refreshed by another session. Resumed.")).toHaveLength(
      1,
    );
    const accounts = (await h.cmd("accounts.list")).body as { id: string; status: string }[];
    expect(accounts.find((a) => a.id === "claude-acme")?.status).toBe("needs-login");
  });
});

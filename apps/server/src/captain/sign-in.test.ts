import type { CaptainAction, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

/**
 * The captain's stuck-task chore and an account that needs a new sign-in (5.18): in a workspace set
 * to "Keeps things tidy", a task whose lead cannot sign in moves to a teammate whose account works.
 * Real services and the fake agent runtime; no tokens are spent.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("the stuck-task chore and a lead that cannot sign in", () => {
  it("moves the task to a teammate whose account works and starts it again", async () => {
    let now = new Date("2026-10-03T01:00:00.000Z");
    w = await bossWorld({ real: false, runClock: () => now });
    const { h } = w;
    const must = (res: { status: number; body: unknown }) => {
      if (res.status !== 200) throw new Error(JSON.stringify(res.body));
      return res.body;
    };
    must(await h.cmd("accounts.create", { id: "codex-acme", tool: "codex", org: "acme", auth: "login" }));
    must(
      await h.cmd("agents.create", {
        id: "acme-lead",
        frontmatter: { scope: "acme", role: "Lead", account: "codex-acme", perms: ["edit", "shell"] },
        instructions: "Lead.\n",
      }),
    );
    must(await h.cmd("autonomy.configure", { tz: "UTC", orgs: { acme: { level: "tidy" } } }));
    must(await h.cmd("autonomy.start", {}));

    // The builder's account cannot sign in: its turn fails the way Claude Code's does.
    const prompts: Record<string, number> = {};
    h.runtime.onSession = (session, start) => {
      const agent = start.account.home.endsWith("claude-acme") ? "acme-builder" : "acme-lead";
      session.script = async (t) => {
        prompts[agent] = (prompts[agent] ?? 0) + 1;
        if (agent === "acme-builder") {
          t.emit({
            type: "text",
            messageId: "auth",
            text: "Failed to authenticate: OAuth session expired and could not be refreshed",
          });
          throw Object.assign(new Error("Authentication required"), { code: -32000 });
        }
        t.emit({ type: "text", messageId: "m", text: "Working on it." });
        return "end_turn";
      };
    };
    const made = must(
      await h.cmd("tasks.create", {
        text: "Fix the api",
        repos: [{ project: "acme-api" }],
        team: ["acme-builder", "acme-lead"],
        start: true,
      }),
    ) as Task;
    const task = () => h.majhi.services.store.tasks.get(made.id);
    await w.until(() => task()?.status === "paused", "the sign-in pause");
    expect(task()?.pausedReason).toBe("signed-out");

    // Later, with the owner away: the chore moves the lead's place and starts the task again.
    now = new Date("2026-10-03T01:30:00.000Z");
    const captain = h.majhi.services.captain;
    await captain.runner.start("acme", "stuck", "Hourly check");
    await h.majhi.services.runs.idle();
    expect(task()?.team[0]).toBe("acme-lead");
    expect(task()?.status).not.toBe("paused");
    expect(prompts["acme-lead"]).toBeGreaterThanOrEqual(1);
    const log = must(await h.cmd("captain.log", { org: "acme" })) as { actions: CaptainAction[] };
    expect(log.actions.map((a) => a.text)).toContain(
      `Moved ${made.id} from @acme-builder to @acme-lead: claude-acme needs a new sign-in`,
    );

    // A second run finds nothing more to do.
    await captain.runner.start("acme", "stuck", "Hourly check");
    const again = must(await h.cmd("captain.log", { org: "acme" })) as { actions: CaptainAction[] };
    expect(again.actions.filter((a) => a.text.startsWith("Moved"))).toHaveLength(1);
  });
});

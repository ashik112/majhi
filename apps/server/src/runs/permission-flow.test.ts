import { describe, expect, it } from "vitest";
import { flow } from "./permission-flow.fixture.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const signal = new AbortController().signal;

describe("what the level lets through without a card", () => {
  /** [the request, whether it asks at Ask me, whether it asks at Routine, whether it asks at Full] */
  const table: [string, boolean, boolean, boolean][] = [
    ["cd api && pnpm test", false, false, false],
    ["pnpm install && pnpm build", false, false, false],
    ["docker pull postgres:16-alpine", false, false, false],
    ["git commit -am 'fix login'", false, false, false],
    ["git push origin fix/login", true, false, false],
    ["git push -u origin HEAD", true, false, false],
    ["gh pr create --draft --fill", true, false, false],
    ["gh pr create --fill", true, true, true],
    ["git push origin main", true, true, false],
    ["gh pr merge 12", true, true, false],
    ["git push origin --delete fix/login", true, true, true],
    ["rm -rf /Users/owner/Documents", true, true, true],
    ["cat /Users/owner/.ssh/id_ed25519", true, true, true],
  ];

  it.each(table)(
    "%s asks at Ask me: %s, at Routine: %s, at Full: %s",
    async (line, atAsk, atRoutine, atFull) => {
      const outcome = async (level: string) => {
        const t = flow({ acme: level });
        const run = t.runOf("ACM-8");
        void t.permissions.ask(run, t.shell(line), signal);
        await tick();
        return run.pending.size === 1;
      };
      expect([await outcome("ask"), await outcome("routine"), await outcome("full")]).toEqual([
        atAsk,
        atRoutine,
        atFull,
      ]);
    },
  );
});

describe("Always", () => {
  const push = "git push origin main";

  it("keeps one rule for the workspace and the kind, and covers the next task there and no other workspace", async () => {
    const t = flow();
    const first = t.runOf("ACM-8");
    const asking = t.permissions.ask(first, t.shell(push), signal);
    await tick();
    expect(t.items.get("perm:4:1")).toMatchObject({
      state: "pending",
      risk: "merge-main",
      options: [{ id: "once" }, { id: "majhi:task" }, { id: "majhi:always" }, { id: "no" }],
    });
    // The captain never answers it: a card is there because the level does not cover it.
    expect(() => t.permissions.answer(first, "ACM-8", "perm:4:1", "majhi:always", true)).toThrow(/owner/);
    t.permissions.answer(first, "ACM-8", "perm:4:1", "majhi:always");
    expect(await asking).toBe("once");
    await tick();
    expect(t.rules).toEqual([{ org: "acme", kind: "merge-main" }]);

    // The next task of the same workspace goes ahead.
    const next = t.runOf("ACM-9");
    expect(await t.permissions.ask(next, t.shell(push), signal)).toBe("once");
    expect(t.items.get("perm:4:1")).toMatchObject({ state: "auto" });

    // Another workspace asks, and so does another kind of action in this one.
    const other = t.runOf("GLX-1");
    void t.permissions.ask(other, t.shell(push), signal);
    await tick();
    expect(other.pending.size).toBe(1);
    const message = t.runOf("ACM-10");
    void t.permissions.ask(message, t.shell("gh pr create --fill"), signal);
    await tick();
    expect(message.pending.size).toBe(1);
  });
});

describe("a card whose prompt is gone", () => {
  it("closes when the agent's next run starts, and a click on it closes it instead of answering", async () => {
    const t = flow();
    const first = t.runOf("ACM-8");
    void t.permissions.ask(first, t.shell("git push origin main"), signal);
    await tick();
    expect(t.items.get("perm:4:1")).toMatchObject({ state: "pending" });

    // A fresh session: a new run of the same agent, with nothing waiting on that card.
    const next = t.runOf("ACM-8");
    t.permissions.dropOrphans(next);
    expect(t.items.get("perm:4:1")).toMatchObject({ state: "cancelled" });

    // A card left pending the same way, then clicked: it closes and says so.
    const other = t.runOf("ACM-9");
    void t.permissions.ask(other, t.shell("git push origin main"), signal);
    await tick();
    const stale = t.runOf("ACM-9");
    expect(() => t.permissions.answer(stale, "ACM-9", "perm:4:1", "once")).toThrow(/ended/);
  });
});

describe("the captain never waits on a card", () => {
  it("is refused at once and told why, keeps the card for the owner, and an Allow lets the command run once and wakes it", async () => {
    const t = flow();
    const run = t.runOf("CAP-1");
    const line = "git push origin main";

    // The call is answered now with the reject option; no prompt holds the run.
    expect(await t.permissions.ask(run, t.shell(line), signal)).toBe("no");
    expect(run.pending.size).toBe(0);
    expect(t.items.get("perm:4:1")).toMatchObject({ state: "pending", risk: "merge-main" });
    // The captain's next majhi call says why, and a task agent in the same spot would still wait.
    expect(t.deferred.take("CAP-1", "acme-claude")).toEqual([
      `\`${line}\` needs the owner, so it did not run. The owner was asked with a card, and you are woken with their answer. Go on with whatever does not need it; do not ask for it again until then.`,
    ]);
    const agent = t.runOf("ACM-8", { runId: 5 });
    void t.permissions.ask(agent, t.shell(line), signal);
    await tick();
    expect(agent.pending.size).toBe(1);

    // A new session does not take the card away; the captain cannot answer it; the owner's Allow wakes the captain.
    t.permissions.dropOrphans(t.runOf("CAP-1"));
    expect(t.items.get("perm:4:1")).toMatchObject({ state: "pending" });
    expect(() => t.permissions.answer(undefined, "CAP-1", "perm:4:1", "once", true)).toThrow(/owner/);
    t.permissions.answer(undefined, "CAP-1", "perm:4:1", "once");
    expect(t.items.get("perm:4:1")).toMatchObject({ state: "answered", chosen: "once" });
    expect(t.woken).toEqual([
      `The owner allowed \`${line}\`. Run it again now: it goes ahead once without asking.`,
    ]);

    // The same command goes ahead once, without a card, and the next one asks again.
    expect(await t.permissions.ask(t.runOf("CAP-1"), t.shell(line), signal)).toBe("once");
    expect(await t.permissions.ask(t.runOf("CAP-1"), t.shell(line), signal)).toBe("no");
  });
});

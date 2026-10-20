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

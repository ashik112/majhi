import type { Authority } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { judgeReport } from "./answer-check.ts";
import { RUNS } from "./authority-fixtures.ts";
import { createChores } from "./chores.ts";
import type { AnswerTask, CaptainPorts } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner, type Workspace } from "./runner.ts";

/** The ship chore on merge/push rows and on tasks that changed no code. */

const NOW = () => new Date("2026-10-04T10:00:00.000Z");

function setup(
  authority: Authority,
  answers: AnswerTask[] = [],
  mr: { ok: boolean } = { ok: true },
  over: { check?: () => unknown; heads?: () => string } = {},
) {
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const calls = { merged: 0, opened: 0, asked: 0, closed: [] as string[], changes: [] as string[] };
  const ports = {
    typing: () => false,
    answerTasks: async () => answers,
    reviewTasks: async () => [{ id: "ACM-1", title: "Add export", heads: over.heads?.() ?? "abc" }],
    shipCheck: async () =>
      over.check?.() ?? {
        ready: true,
        evidence: "checks pass",
        targets: [{ project: "api", into: "main", base: "main" }],
      },
    ship: async () => {
      calls.merged += 1;
      return { text: "Shipped ACM-1" };
    },
    shipReady: async () => {
      calls.asked += 1;
    },
    mrReady: async () => (mr.ok ? { ok: true, host: "GitLab" } : { ok: false, why: "No remote" }),
    openMrs: async () => {
      calls.opened += 1;
      return { urls: ["https://gitlab.example/acme/api/-/merge_requests/7"], host: "GitLab" };
    },
    closeAnswer: async (_org: string, id: string) => {
      calls.closed.push(id);
    },
    askChanges: async (_org: string, _id: string, text: string) => {
      calls.changes.push(text);
    },
  } as unknown as CaptainPorts;
  const ws = (): Workspace => ({
    org: "acme",
    name: "Acme",
    mode: "on",
    authority,
    rules: undefined,
    tz: "UTC",
    day: "2026-10-04",
    rulesOff: new Set(),
  });
  const runner = new ChoreRunner({
    repo,
    now: NOW,
    workspace: async () => ws(),
    stopped: () => false,
    tellOwner: () => undefined,
    caused: () => undefined,
    laneTokens: () => 0,
    chores: createChores(ports, NOW),
  });
  const run = async () => {
    const r = await runner.startNow("acme", "ship");
    if (r.ran) await r.done;
  };
  return { run, calls, repo };
}

describe("ship with Merge on the owner", () => {
  it("opens the merge request and never merges when Push is the captain's", async () => {
    const t = setup({ ...RUNS, merge: "ask", push: "decide" });
    await t.run();
    expect(t.calls).toMatchObject({ merged: 0, opened: 1, asked: 0 });
    const line = t.repo.allActions().find((a) => a.text.startsWith("Opened a merge request"));
    expect(line?.text).toBe(
      "Opened a merge request for ACM-1 on GitLab: Add export. https://gitlab.example/acme/api/-/merge_requests/7. Merge it on GitLab",
    );
  });

  it("opens it once for the same state of the work", async () => {
    const t = setup({ ...RUNS, merge: "ask", push: "decide" });
    await t.run();
    await t.run();
    expect(t.calls.opened).toBe(1);
  });

  it("leaves the card for the owner when Push is also theirs", async () => {
    const t = setup({ ...RUNS, merge: "ask", push: "ask" });
    await t.run();
    expect(t.calls).toMatchObject({ merged: 0, opened: 0, asked: 1 });
  });

  it("leaves the card with the reason when the repo cannot open one", async () => {
    const t = setup({ ...RUNS, merge: "ask", push: "decide" }, [], { ok: false });
    await t.run();
    expect(t.calls).toMatchObject({ merged: 0, opened: 0, asked: 1 });
    expect(t.repo.allActions().some((a) => a.reason.includes("No remote"))).toBe(true);
  });
});

describe("a task with uncommitted changes", () => {
  const dirty = (files: string[]) => ({
    ready: false,
    why: `oryza has uncommitted changes: ${files.join(", ")}`,
    uncommitted: { project: "oryza", files },
  });

  it("sends the lead one line naming the files, and not again for the same state", async () => {
    const t = setup(
      { ...RUNS, merge: "ask", push: "decide" },
      [],
      { ok: true },
      { check: () => dirty(["a.ts", "b.ts"]) },
    );
    await t.run();
    await t.run();
    expect(t.calls.changes).toEqual([
      "Captain: Commit or discard the uncommitted changes in oryza: a.ts, b.ts",
    ]);
    expect(t.calls.opened).toBe(0);
  });

  it("asks twice at most, then leaves it for the owner", async () => {
    let n = 0;
    const t = setup(
      { ...RUNS, merge: "ask", push: "decide" },
      [],
      { ok: true },
      { check: () => dirty([`f${n}.ts`]), heads: () => `head${n}` },
    );
    for (n = 1; n <= 4; n++) await t.run();
    expect(t.calls.changes).toHaveLength(2);
    expect(t.repo.allActions().some((a) => a.text.includes("is not ready to ship"))).toBe(true);
  });
});

describe("tasks that changed no code", () => {
  const done = "The invoice stayed Pending because the webhook retried after the deadline. ".repeat(3);
  const task = (text: string | undefined): AnswerTask => ({
    id: "ACM-2",
    title: "Why did it stay Pending",
    lead: "lead",
    report: text === undefined ? undefined : { text, at: "2026-10-04T09:00:00.000Z" },
  });

  it("marks done a task whose report answers the brief", async () => {
    const t = setup({ ...RUNS, upkeep: "decide" }, [task(done)]);
    await t.run();
    expect(t.calls.closed).toEqual(["ACM-2"]);
    expect(t.calls.changes).toEqual([]);
  });

  it("asks the lead for changes when the report ends with an open question", async () => {
    const t = setup({ ...RUNS, upkeep: "decide" }, [task(`${done}\n\nShould I also check the retry queue?`)]);
    await t.run();
    expect(t.calls.closed).toEqual([]);
    expect(t.calls.changes).toHaveLength(1);
    expect(t.calls.changes[0]).toContain("Should I also check the retry queue?");
  });

  it("sends a task back twice at most, then leaves it for the owner", async () => {
    const asks = (n: number): AnswerTask => ({
      ...task(`${done}\n\nShould I also check the retry queue?`),
      report: { text: `${done}\n\nShould I also check queue ${n}?`, at: `2026-10-04T0${n}:00:00.000Z` },
    });
    const list = [asks(1)];
    const t = setup({ ...RUNS, upkeep: "decide" }, list);
    for (const n of [1, 2, 3, 4]) {
      list[0] = asks(n);
      await t.run();
    }
    expect(t.calls.changes).toHaveLength(2);
    expect(t.calls.closed).toEqual([]);
  });

  it("does nothing when neither upkeep nor questions is the captain's", async () => {
    const t = setup({ ...RUNS, upkeep: "ask", questions: "ask" }, [task(done)]);
    await t.run();
    expect(t.calls.closed).toEqual([]);
  });

  it("reads a report", () => {
    expect(judgeReport(undefined).complete).toBe(false);
    expect(judgeReport(`${done}\n\nOpen questions: none.`).complete).toBe(true);
  });
});

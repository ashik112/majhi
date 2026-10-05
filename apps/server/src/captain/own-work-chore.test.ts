import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_ASK, type Authority } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { createChores } from "./chores.ts";
import type { OwnWorkScope } from "./own-work.ts";
import type { CaptainPorts, QuestionCard } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner } from "./runner.ts";

/**
 * The questions chore with the Own work row, over ports that record what they were asked to do. The
 * rows are Questions = You and Own work = Captain, as a client workspace is set when the owner turns
 * only Own work on.
 */

const OWN: Authority = { ...ALL_ASK, own: "decide" };

function desk(authority: Authority = OWN, started: readonly string[] = ["ACM-1"]) {
  const tree = join(mkdtempSync(join(tmpdir(), "own-chore-")), "ACM-1", "acme-api");
  mkdirSync(tree, { recursive: true });
  const scope: OwnWorkScope = { worktrees: [tree], cwd: tree };
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const cards: QuestionCard[] = [];
  const answers: { task: string; item: string; option: string; reason: string }[] = [];
  const lane: string[] = [];
  const ports = {
    questions: () => cards.filter((c) => !answers.some((a) => a.item === c.item)),
    typing: () => false,
    ownScope: async (_org: string, task: string) => (started.includes(task) ? scope : undefined),
    answer: async (_org: string, card: QuestionCard, option: string, reason: string) => {
      answers.push({ task: card.task, item: card.item, option, reason });
      return { answered: true as const };
    },
    laneRest: async () => undefined,
    askLane: async (_org: string, text: string) => {
      lane.push(text);
      return { sent: true as const };
    },
  } as unknown as CaptainPorts;
  const runner = new ChoreRunner({
    repo,
    now: () => new Date(Date.UTC(2026, 9, 4, 12, 0, 0)),
    workspace: async () => ({
      org: "acme",
      name: "Acme",
      mode: "on",
      authority,
      rules: undefined,
      tz: "UTC",
      day: "2026-10-04",
    }),
    stopped: () => false,
    tellOwner: () => {},
    laneTokens: () => 0,
    chores: createChores(ports, () => new Date(Date.UTC(2026, 9, 4, 12, 0, 0))),
  });
  let n = 0;
  const ask = async (text: string, task = "ACM-1") => {
    n++;
    cards.push({
      task,
      item: `p${n}`,
      agent: "acme-builder",
      kind: "permission",
      text,
      options: [
        { id: "once", label: "Allow once", effect: "allow" },
        { id: "no", label: "Reject", effect: "deny" },
      ],
    });
    await runner.start("acme", "questions", "a prompt");
  };
  const log = () => repo.actions({ org: "acme", limit: 100 }).map((a) => [a.outcome, a.text, a.reason]);
  return { ask, answers, lane, log };
}

describe("Own work in the questions chore", () => {
  it("approves a test run of a task the captain started, with the reason in the log", async () => {
    const d = desk();
    await d.ask("Run pnpm test");
    expect(d.answers).toEqual([
      { task: "ACM-1", item: "p1", option: "once", reason: "Own work: it runs the project's test script" },
    ]);
    expect(d.log()[0]?.[1]).toBe("Approved in ACM-1: Run pnpm test");
    expect(String(d.log()[0]?.[2])).toContain("Own work");
  });

  it("never approves a request from a task the captain did not start", async () => {
    const d = desk(OWN, ["ACM-2"]);
    await d.ask("Run pnpm test", "ACM-1");
    expect(d.answers).toEqual([]);
    expect(d.lane).toEqual([]);
    expect(d.log()).toEqual([]);
  });

  it("does nothing while the row is You, even for a task it started", async () => {
    const d = desk({ ...OWN, own: "ask" });
    await d.ask("Run pnpm test");
    expect(d.answers).toEqual([]);
    expect(d.log()).toEqual([]);
  });

  it("with Questions on Captain too, does not approve what its rules reject", async () => {
    const d = desk({ ...OWN, questions: "decide" });
    await d.ask("Bash: git push --force origin main");
    // The Questions row's rule table rejects it; Own work never allows it.
    expect(d.answers.map((a) => a.option)).toEqual(["no"]);
  });
});

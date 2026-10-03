import { ALL_ASK, type Authority } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { createChores } from "./chores.ts";
import type { CaptainPorts, QuestionCard } from "./ports.ts";
import { loopLine, nearSame, type PastAnswer, questionLoop } from "./question-loop.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner } from "./runner.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + minutes * 60_000);
const answered = (minutes: number, question = "Should I continue?"): PastAnswer => ({
  at: at(minutes).toISOString(),
  question,
  answer: "Yes",
});

describe("recognising an agent that keeps asking", () => {
  it("counts the same question again within ten minutes as a loop, and a different one as fine", () => {
    expect(questionLoop([answered(0)], "Should I continue?", at(8))).toMatchObject({ times: 2, minutes: 10 });
    expect(questionLoop([answered(0)], "should i continue", at(8))).toBeDefined();
    expect(questionLoop([answered(0)], "Which database should hold the sessions?", at(8))).toBeUndefined();
    // Eleven minutes later it is a new question.
    expect(questionLoop([answered(0)], "Should I continue?", at(11))).toBeUndefined();
  });

  it("counts the third question in five minutes as a loop, whatever it says", () => {
    const past = [answered(0, "Use tabs?"), answered(2, "Rename the file?")];
    expect(questionLoop(past, "Add a test?", at(4))).toMatchObject({
      times: 3,
      minutes: 5,
      since: past[0]?.at,
    });
    expect(questionLoop(past, "Add a test?", at(6))).toBeUndefined();
  });

  it("says it in one line", () => {
    expect(loopLine("pyzasoft-claude", "PYZ-7", { times: 4, minutes: 5 })).toBe(
      "@pyzasoft-claude keeps asking in PYZ-7 (4 times in 5 minutes); it may be stuck",
    );
    expect(nearSame("Yes or no?", "Completely different words here")).toBe(false);
  });
});

const TIDY: Authority = { ...ALL_ASK, questions: "decide" };

/** The questions chore over a database in memory and ports that record what they were asked to do. */
function desk() {
  const repo = new CaptainRepo(new Store(":memory:").raw);
  let now = at(0);
  const cards: QuestionCard[] = [];
  const answers: { item: string; option: string }[] = [];
  const flags: { line: string; nudge: string }[] = [];
  const lane: string[] = [];
  // No decision provider here: the chore has no port for one, so a call to it would throw.
  const ports = {
    questions: () => cards.filter((c) => !answers.some((a) => a.item === c.item)),
    typing: () => false,
    answer: async (_org: string, card: QuestionCard, option: string) => {
      answers.push({ item: card.item, option });
    },
    flagLoop: async (_org: string, _card: QuestionCard, line: string, nudge: string) => {
      flags.push({ line, nudge });
    },
    laneRest: async () => undefined,
    askLane: async (_org: string, text: string) => {
      lane.push(text);
      return { sent: true as const };
    },
  } as unknown as CaptainPorts; // Only the ports the questions chore calls.
  const runner = new ChoreRunner({
    repo,
    now: () => now,
    workspace: async () => ({
      org: "acme",
      name: "Acme",
      mode: "on",
      authority: TIDY,
      rules: undefined,
      tz: "UTC",
      day: "2026-10-04",
    }),
    stopped: () => false,
    tellOwner: () => {},
    caused: () => {},
    laneTokens: () => 0,
    chores: createChores(ports, () => now),
  });
  const permission = async (item: string, text: string, agent = "pyzasoft-claude") => {
    cards.push({
      task: "PYZ-7",
      item,
      agent,
      kind: "permission",
      text,
      options: [
        { id: "once", label: "Allow once", effect: "allow" },
        { id: "no", label: "Reject", effect: "deny" },
      ],
    });
    await runner.start("acme", "questions", "a prompt");
  };
  const question = async (item: string, text: string) => {
    cards.push({
      task: "PYZ-7",
      item,
      agent: "pyzasoft-claude",
      kind: "choice",
      text,
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    });
    await runner.start("acme", "questions", "a question");
  };
  const actions = () => repo.actions({ org: "acme", limit: 100 }).map((a) => [a.outcome, a.text]);
  return {
    permission,
    question,
    answers,
    flags,
    lane,
    actions,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

describe("the questions chore and permission prompts", () => {
  it("never approves a prompt whose text says nothing", async () => {
    const d = desk();
    await d.permission("p1", "\u2026");
    await d.permission("p2", "   ");
    expect(d.answers).toEqual([]);
    expect(d.lane).toEqual([]);
    expect(d.actions().map(([outcome]) => outcome)).toEqual(["asked", "asked"]);
  });

  it("rejects a dangerous argument by rule and allows a read tool of majhi by rule", async () => {
    const d = desk();
    await d.permission("p1", "Bash: git push --force origin main");
    await d.permission("p2", "mcp__majhi-containers__logs");
    expect(d.answers).toEqual([
      { item: "p1", option: "no" },
      { item: "p2", option: "once" },
    ]);
  });

  it("does not settle a write by rule: the captain's own turn looks, with the prompt", async () => {
    const d = desk();
    await d.permission("p1", "mcp__majhi-containers__service_start");
    expect(d.answers).toEqual([]);
    expect(d.lane).toHaveLength(1);
    expect(d.lane[0]).toContain("mcp__majhi-containers__service_start");
  });

  it("flags an agent whose read prompts repeat, and answers no more of the loop", async () => {
    const d = desk();
    for (let i = 0; i < 6; i++) {
      await d.permission(`p${i}`, "mcp__majhi-containers__logs");
      d.advance(16);
    }
    expect(d.answers).toHaveLength(1);
    expect(d.flags).toHaveLength(1);
    expect(d.flags[0]?.line).toBe(
      "@pyzasoft-claude keeps asking in PYZ-7 (2 times in 10 minutes); it may be stuck",
    );
    expect(d.flags[0]?.nudge).toContain("do not ask it again");
  });
});

describe("the questions chore and agents' questions", () => {
  it("is not answered by a decision provider: it goes to the captain's turn", async () => {
    const d = desk();
    await d.question("c1", "Should I go on with the migration?");
    expect(d.answers).toEqual([]);
    expect(d.lane).toHaveLength(1);
    expect(d.lane[0]).toContain("Should I go on with the migration?");
  });
});

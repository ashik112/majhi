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
  const answers: string[] = [];
  const flags: { line: string; nudge: string }[] = [];
  let margin = 0.6;
  const ports = {
    questions: () => cards.filter((c) => !answers.includes(c.item)),
    typing: () => false,
    laya: async (_org: string, card: QuestionCard) => ({
      option: card.options[0]?.id,
      why: "the brief settles it",
      margin,
    }),
    answer: async (_org: string, card: QuestionCard) => {
      answers.push(card.item);
    },
    flagLoop: async (_org: string, _card: QuestionCard, line: string, nudge: string) => {
      flags.push({ line, nudge });
    },
    laneRest: async () => "resting",
    askLane: async () => ({ sent: false as const, why: "resting" }),
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
  const ask = async (item: string, text: string, agent = "pyzasoft-claude") => {
    cards.push({
      task: "PYZ-7",
      item,
      agent,
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
    ask,
    answers,
    flags,
    actions,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
    setMargin: (m: number) => {
      margin = m;
    },
  };
}

describe("the questions chore and an agent that keeps asking", () => {
  it("answers the first ask, then leaves a repeat for the owner, tells the agent once, and answers no more of the loop", async () => {
    const d = desk();
    for (let i = 0; i < 15; i++) {
      await d.ask(`choice:${i}`, "Should I go on with the migration?");
      d.advance(16);
    }
    expect(d.answers).toEqual(["choice:0"]);
    expect(d.flags).toHaveLength(1);
    expect(d.flags[0]?.line).toBe(
      "@pyzasoft-claude keeps asking in PYZ-7 (2 times in 10 minutes); it may be stuck",
    );
    expect(d.flags[0]?.nudge).toContain('The captain answered: "Yes"');
    expect(d.flags[0]?.nudge).toContain("do not ask it again");
    const asked = d.actions().filter(([outcome]) => outcome === "asked");
    expect(asked).toEqual([["asked", d.flags[0]?.line]]);
  });

  it("answers different questions from other agents, and a different one after the loop is over", async () => {
    const d = desk();
    await d.ask("choice:0", "Should I go on with the migration?");
    await d.ask("choice:1", "Which logger should the worker use?", "pyzasoft-codex");
    expect(d.answers).toEqual(["choice:0", "choice:1"]);
    d.advance(11 * 60);
    await d.ask("choice:2", "Should I go on with the migration?");
    expect(d.answers).toEqual(["choice:0", "choice:1", "choice:2"]);
    expect(d.flags).toEqual([]);
  });

  it("never answers when Laya led by less than the floor, and leaves it for the owner", async () => {
    const d = desk();
    d.setMargin(0.27);
    await d.ask("choice:0", "Should I go on with the migration?");
    expect(d.answers).toEqual([]);
    expect(d.actions()).toEqual([
      ["asked", "Left a question in PYZ-7 for you: Should I go on with the migration?"],
    ]);
    d.setMargin(0.47);
    await d.ask("choice:1", "Which logger should the worker use?");
    expect(d.answers).toEqual(["choice:1"]);
  });
});

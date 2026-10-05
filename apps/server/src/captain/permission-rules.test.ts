import { describe, expect, it } from "vitest";
import { decidePermission, toolAllowKey } from "../runs/permissions.ts";
import { answerFor, coveredForTask } from "./permission-rules.ts";

const options = [
  { id: "once", kind: "allow_once" },
  { id: "task", kind: "allow_always" },
  { id: "no", kind: "reject_once" },
];
const START = "mcp__majhi-containers__service_start";

describe("what the captain's yes becomes", () => {
  it("stays Allow once for a judgment call, a rejection, and a prompt without the option", () => {
    expect(answerFor("mcp__other__deploy", options, "once")).toBe("once");
    expect(answerFor("Bash: npm test", options, "once")).toBe("once");
    expect(answerFor(START, options, "no")).toBe("no");
    expect(
      answerFor(
        START,
        options.filter((o) => o.id !== "task"),
        "once",
      ),
    ).toBe("once");
    expect(coveredForTask("mcp__majhi-admin__tasks_merge")).toBe(false);
  });

  it("makes the next call of that tool, and only that tool, run without asking", () => {
    const ask = (title: string) => ({
      title,
      kind: "other",
      options: [{ id: "once", name: "Yes", kind: "allow_once" as const }],
    });
    const remembered = [toolAllowKey(START)];
    const decide = (title: string) =>
      decidePermission(ask(title), { perms: [], rememberedFor: (k) => remembered.includes(k) });
    expect(decide(START)).toEqual({ action: "allow", option: "once", via: "task" });
    expect(decide("mcp__majhi-containers__service_stop")).toEqual({ action: "ask" });
    expect(decide("mcp__other__deploy")).toEqual({ action: "ask" });
  });
});

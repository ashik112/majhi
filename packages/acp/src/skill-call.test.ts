import { describe, expect, it } from "vitest";
import { MessageRuns, normalizeUpdate } from "./normalize.ts";

const meta = { claudeCode: { toolName: "Skill" } };
// The updates are the ACP shape claude-agent-acp 0.84.0 sends.
const run = (update: object) => normalizeUpdate(update as never, new MessageRuns("m"), () => undefined);

describe("Claude Code's Skill tool call", () => {
  it("names the skill once the input is complete, not on the empty first report", () => {
    const first = run({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Load skill",
      rawInput: {},
      _meta: meta,
    });
    expect(first[0]).not.toHaveProperty("skill");
    const refined = run({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      rawInput: { skill: "triage" },
      _meta: meta,
    });
    expect(refined[0]).toMatchObject({ type: "tool", toolCallId: "c1", skill: "triage" });
  });

  it("is not a skill call when another tool has a skill field", () => {
    const other = run({
      sessionUpdate: "tool_call",
      toolCallId: "c2",
      rawInput: { skill: "triage" },
      _meta: { claudeCode: { toolName: "Bash" } },
    });
    expect(other[0]).not.toHaveProperty("skill");
  });
});

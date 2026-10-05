import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { skillUsed } from "./use.ts";

const skills = { names: ["review-mr", "triage"], dir: "/home/owner/.majhi/run/connections/skills-ab12" };
const tool = (extra: object) => ({ type: "tool" as const, toolCallId: "t1", ...extra });

describe("skillUsed", () => {
  it("takes Claude's Skill tool by its typed name, only for a skill the run has", () => {
    expect(skillUsed(tool({ skill: "triage" }), skills)).toBe("triage");
    expect(skillUsed(tool({ skill: "frontend-design" }), skills)).toBeUndefined();
  });

  it("takes a read of a skill's SKILL.md in the run's copies or the task's .claude/skills", () => {
    const copy = `${skills.dir}/review-mr/SKILL.md`;
    expect(skillUsed(tool({ kind: "read", locations: [copy] }), skills)).toBe("review-mr");
    const mount = "/home/owner/tasks/T-1/.claude/skills/triage/SKILL.md";
    expect(skillUsed(tool({ kind: "read", locations: [mount] }), skills)).toBe("triage");
  });

  it("ignores other files, other folders and names the run does not have", () => {
    const other = `${skills.dir}/review-mr/references/a.md`;
    expect(skillUsed(tool({ locations: [other] }), skills)).toBeUndefined();
    expect(skillUsed(tool({ locations: ["/home/owner/repo/triage/SKILL.md"] }), skills)).toBeUndefined();
    expect(skillUsed(tool({ locations: [`${skills.dir}/other/SKILL.md`] }), skills)).toBeUndefined();
    expect(skillUsed(tool({ skill: "triage" }), undefined)).toBeUndefined();
  });
});

describe("skill usage", () => {
  it("counts a tool call once, and sums last-used and the 30 day window per skill in one query", () => {
    const store = new Store(":memory:");
    store.raw
      .prepare(
        "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES ('T-1', 't', 'b', 'code', 'open', '/t', '[]', 'x', 'x')",
      )
      .run();
    const run = store.runs.start({ task: "T-1", agent: "a", sessionId: "s", at: "2027-01-01T00:00:00.000Z" });
    expect(store.runs.recordSkillUse(run, "c1", "triage", "2026-11-01T00:00:00.000Z")).toBe(true);
    expect(store.runs.recordSkillUse(run, "c1", "triage", "2026-11-01T00:00:01.000Z")).toBe(false);
    store.runs.recordSkillUse(run, "c2", "triage", "2026-12-20T00:00:00.000Z");
    store.runs.recordSkillUse(run, "c3", "review-mr", "2026-12-25T00:00:00.000Z");
    const usage = store.runs.skillUsage("2026-12-01T00:00:00.000Z");
    expect(usage.get("triage")).toEqual({ lastUsedAt: "2026-12-20T00:00:00.000Z", uses: 1 });
    expect(usage.get("review-mr")).toEqual({ lastUsedAt: "2026-12-25T00:00:00.000Z", uses: 1 });
    expect(usage.get("nothing")).toBeUndefined();
  });
});

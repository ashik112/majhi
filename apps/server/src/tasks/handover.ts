import type { TeamPlan } from "@majhi/shared";

/**
 * The note a lead handover posts in the room and wakes the new lead with (SPEC 5.18): the plan, what
 * is done and what is next, so the new lead starts with the context.
 */

export interface HandoverInput {
  task: string;
  from: string;
  to: string;
  /** Why, in the caller's words. */
  reason?: string | undefined;
  /** Who made the change: "the owner", "the captain" or "@lead". */
  by: string;
  /** The lead's latest recorded plan, if any. */
  plan?: TeamPlan | undefined;
  /** Per repo, the newest commits of the task's branch since its base, newest first. */
  commits: readonly { project: string; subjects: readonly string[] }[];
  /** Whether the old lead stays on the team as a builder. */
  oldStays: boolean;
}

const COMMITS_PER_REPO = 8;

export function handoverNote(i: HandoverInput): string {
  const lines = [`Handover on ${i.task}: @${i.to} is the lead now, taking over from @${i.from} (${i.by}).`];
  if (i.reason !== undefined && i.reason !== "") lines.push(`Why: ${i.reason}`);
  lines.push("", "Plan:");
  if (i.plan === undefined) {
    lines.push("- No plan was recorded. Read the room and TASK.md, then record one with record_plan.");
  } else {
    lines.push(
      ...i.plan.steps.map((s, n) => `${n + 1}. ${s.who}: ${s.what}`),
      `Why this plan: ${i.plan.why}`,
    );
  }
  lines.push("", "Done so far:");
  const withCommits = i.commits.filter((c) => c.subjects.length > 0);
  if (withCommits.length === 0) {
    lines.push("- Nothing is committed yet.");
  } else {
    for (const c of withCommits) {
      lines.push(`- ${c.project}:`);
      for (const s of c.subjects.slice(0, COMMITS_PER_REPO)) lines.push(`  - ${s}`);
    }
  }
  lines.push(
    "",
    "Next:",
    "- Carry on with the plan from the last commit. Check the room for anything @" +
      `${i.from} left open, then say the plan in a few lines and go on.`,
    i.oldStays
      ? `- @${i.from} stays on the team as a builder. Hand work to it with a mention.`
      : `- @${i.from} left the team.`,
  );
  return lines.join("\n");
}

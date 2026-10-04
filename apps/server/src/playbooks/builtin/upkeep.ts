import type { Playbook } from "@majhi/shared";

/**
 * The upkeep pack: the captain's standing chores as playbooks (SPEC 5.18, Upkeep). Each is carried out
 * by its chore, under the same guards, caps and log as before. The steps say what the chore does.
 * Cadence: the daily ones run once a day, the others when their event happens and once an hour for what
 * a restart missed.
 */

const HOURLY = { kind: "every", minutes: 60 } as const;
const DAILY = { kind: "daily", at: "00:00" } as const;
/** The token cap of one chore run (RUN_CAPS in captain/rules.ts). */
const RUN_TOKENS = 60_000;

type Data = Omit<Playbook, "pack" | "enabledByDefault" | "scope" | "channels" | "settings" | "needs">;

const upkeep = (d: Data): Playbook => ({
  ...d,
  pack: "upkeep",
  scope: "workspace",
  channels: [],
  settings: [],
  enabledByDefault: true,
});

export const UPKEEP_PLAYBOOKS: Playbook[] = [
  upkeep({
    id: "upkeep-ship",
    name: "Ship finished work",
    purpose: "Merge and push tasks that reached review, by the workspace's ship rule, or ask you.",
    trigger: { cadence: HOURLY, events: ["A task reaches review"] },
    inputs: ["Tasks in review", "Their diffs and checks", "The workspace's allowed branches"],
    steps:
      "For each task in review: check it is committed, merges cleanly, has no card waiting and no secret in the diff. Where Merge is Captain, merge it and push by the Push row. Where it is You, ask with one ready-to-ship card.",
    outputs: ["decision", "log"],
    cost: { tier: "rules", tokens: RUN_TOKENS },
    turnOn: "Ships finished work by the Merge and Push rows in Delegation.",
    runner: { kind: "chore", chore: "ship" },
  }),
  upkeep({
    id: "upkeep-cards",
    name: "Approval cards",
    purpose: "Answer routine approval cards by the workspace's rules. Risky ones go to you.",
    trigger: { cadence: HOURLY, events: ["A card arrives"] },
    inputs: ["Pending approval cards"],
    steps:
      "Read each pending card. Approve what the Approvals rules allow. Leave anything on the never list, and anything unclear, for the owner.",
    outputs: ["decision", "log"],
    cost: { tier: "laya", tokens: RUN_TOKENS },
    turnOn: "Answers routine approval cards where Approvals is Captain.",
    runner: { kind: "chore", chore: "cards" },
  }),
  upkeep({
    id: "upkeep-questions",
    name: "Agents' questions",
    purpose: "Answer an agent's question from the brief, memory or the code, or leave it for you.",
    trigger: { cadence: HOURLY, events: ["An agent asks"] },
    inputs: ["Pending questions and permission prompts"],
    steps:
      "Settle a permission prompt by the rule table. Answer a question only when the brief, memory or the code settles it; otherwise leave it. An agent that asks the same thing again and again is left for the owner.",
    outputs: ["decision", "log"],
    cost: { tier: "small", tokens: RUN_TOKENS },
    turnOn: "Answers agents' questions where Questions is Captain.",
    runner: { kind: "chore", chore: "questions" },
  }),
  upkeep({
    id: "upkeep-memory",
    name: "Memory",
    purpose: "Keep, merge or drop memories that wait for review.",
    trigger: { cadence: DAILY, events: ["10 memories wait for review"] },
    inputs: ["Memories waiting for review"],
    steps:
      "Keep a durable, non-obvious fact. Drop a one-off symptom, generic advice or what the docs already say. Merge a copy into the fact it repeats. Leave a contradiction for the owner.",
    outputs: ["log"],
    cost: { tier: "laya", tokens: RUN_TOKENS },
    turnOn: "Reviews waiting memories once a day. It also runs while Auto-pilot is off.",
    runner: { kind: "chore", chore: "memory" },
  }),
  upkeep({
    id: "upkeep-projects",
    name: "Projects",
    purpose: "Register a new repo found in the workspace's folder.",
    trigger: { cadence: DAILY, events: ["A new repo appears"] },
    inputs: ["Repos in the workspace's roots"],
    steps:
      "Register a new repo with its base branch and remotes. Ask when unsure. Never touch a protected repo.",
    outputs: ["log"],
    cost: { tier: "rules", tokens: RUN_TOKENS },
    turnOn: "Registers new repos where Upkeep is Captain.",
    runner: { kind: "chore", chore: "projects" },
  }),
  upkeep({
    id: "upkeep-triage",
    name: "Task triage",
    purpose: "Set priority, mark duplicates and stale tasks. It suggests closing and never closes.",
    trigger: { cadence: DAILY, events: [] },
    inputs: ["Open tasks"],
    steps:
      "Raise the priority of a task due soon. Mark tasks with the same title as duplicates. Suggest closing a task nobody touched for 30 days. Never close one.",
    outputs: ["log"],
    cost: { tier: "rules", tokens: RUN_TOKENS },
    turnOn: "Triages open tasks once a day where Upkeep is Captain.",
    runner: { kind: "chore", chore: "triage" },
  }),
  upkeep({
    id: "upkeep-cleanup",
    name: "Cleanup",
    purpose: "Remove the checkouts and containers of done tasks. Never uncommitted work.",
    trigger: { cadence: DAILY, events: [] },
    inputs: ["Done tasks and what they left behind"],
    steps:
      "Remove what a done task left behind once it is merged or kept elsewhere. Never remove uncommitted work.",
    outputs: ["log"],
    cost: { tier: "rules", tokens: RUN_TOKENS },
    turnOn: "Cleans up done tasks once a day. It also runs while Auto-pilot is off.",
    runner: { kind: "chore", chore: "cleanup" },
  }),
  upkeep({
    id: "upkeep-stuck",
    name: "Stuck tasks",
    purpose: "Wake a lead once when nobody works and nothing is pending, then tell you.",
    trigger: { cadence: HOURLY, events: ["A running task goes quiet"] },
    inputs: ["Running tasks with no agent working"],
    steps:
      "Move a step off an account that needs a sign-in to a teammate. Wake the lead of a quiet task once. If it stays quiet, pause the task and tell the owner.",
    outputs: ["log"],
    cost: { tier: "rules", tokens: RUN_TOKENS },
    turnOn: "Watches running tasks that go quiet where Upkeep is Captain.",
    runner: { kind: "chore", chore: "stuck" },
  }),
  upkeep({
    id: "upkeep-followups",
    name: "Follow-ups",
    purpose: "Close follow-ups that are done and report the rest as findings.",
    trigger: { cadence: DAILY, events: [] },
    inputs: ["Open follow-ups in memory", "Done tasks"],
    steps:
      "Close a follow-up whose task is done or that a later task did. Merge a repeat of an older one. Report the rest as findings and propose a task for concrete work.",
    outputs: ["finding", "task", "log"],
    cost: { tier: "laya", tokens: RUN_TOKENS },
    turnOn: "Reads the open follow-ups of memory once a day where Upkeep is Captain.",
    runner: { kind: "chore", chore: "followups" },
  }),
  // Runs once for the whole business, from Private. Pure code: it asks Laya, which is local, so it costs no tokens.
  {
    id: "upkeep-laya-eval",
    name: "Laya check",
    pack: "upkeep",
    purpose:
      "Test each of Laya's decisions on your own corrections every week, and file a finding for any that got worse.",
    trigger: { cadence: { kind: "weekly", day: 0, at: "03:00" }, events: [] },
    scope: "business",
    inputs: [
      "Your corrections and outcomes stored for each decision",
      "The built-in examples of each decision",
    ],
    steps:
      "Run every decision slot on its stored labels and built-in examples, refit each threshold on the labels it has now, and compare with the run before. A slot that lost precision, or went back to shadow, becomes a finding. Also read the findings that were filed before triage existed, a few at a time.",
    outputs: ["finding", "log"],
    channels: [],
    cost: { tier: "rules", tokens: 0 },
    readOnly: true,
    enabledByDefault: true,
    turnOn:
      "Checks Laya against your own corrections once a week and files a finding if a decision got worse. Nothing leaves your machine.",
    runner: { kind: "rules", id: "laya-eval" },
    settings: [],
  },
];

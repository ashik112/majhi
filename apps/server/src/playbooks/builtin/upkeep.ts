import type { Playbook } from "@majhi/shared";
import { PASS_BOUND } from "../../captain/rules.ts";

/**
 * The upkeep pack: the captain's standing chores as playbooks (SPEC 5.18, Upkeep). Each is carried out
 * by its chore, under the same guards, pass bound and log as before. The steps say what the chore does.
 * Cadence: the daily ones run once a day, the others when their event happens and once an hour for what
 * a restart missed.
 */

const HOURLY = { kind: "every", minutes: 60 } as const;
const DAILY = { kind: "daily", at: "00:00" } as const;

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
    purpose: "Merges tasks whose checks pass. Never pushes unless Push is Captain.",
    trigger: { cadence: HOURLY, events: ["A task reaches review"] },
    inputs: ["Tasks in review", "Their diffs and checks", "The workspace's allowed branches"],
    steps:
      "For each task in review: check it is committed, merges cleanly, has no card waiting and no secret in the diff. Where Merge is Captain, merge it and push by the Push row. Where it is You, ask with one ready-to-ship card.",
    outputs: ["decision", "log"],
    cost: { tier: "rules", tokens: PASS_BOUND.tokens },
    turnOn: "Ships finished work by the Merge and Push rows in Delegation.",
    outcomes: [
      { id: "ship-merge", text: "Checks pass and Merge is Captain: merge it, tell me in the brief" },
      {
        id: "ship-mr",
        text: "Checks pass, Merge is You and Push is Captain: open the merge request, I merge it",
      },
      {
        id: "ship-answer",
        text: "No code change: mark it done when the report answers the brief, else ask the lead",
      },
      { id: "ship-ask", text: "Checks pass and Merge is You: ask me in Needs you" },
      { id: "ship-checks", text: "Checks fail: send the exact failures to the lead, ask me after 3 tries" },
      { id: "ship-conflict", text: "Conflicts with main: ask the lead to resolve it, then try again" },
      { id: "ship-notready", text: "Not committed, a card waits or a secret in the diff: tell me why" },
    ],
    runner: { kind: "chore", chore: "ship" },
  }),
  upkeep({
    id: "upkeep-cards",
    name: "Approval cards",
    purpose: "Approves routine cards by your rules. Risky ones wait for you.",
    trigger: { cadence: HOURLY, events: ["A card arrives"] },
    inputs: ["Pending approval cards"],
    steps:
      "Read each pending card. Approve what the Approvals rules allow. Leave anything on the never list, and anything unclear, for the owner.",
    outputs: ["decision", "log"],
    cost: { tier: "laya", tokens: PASS_BOUND.tokens },
    turnOn: "Answers routine approval cards where Approvals is Captain.",
    outcomes: [
      { id: "cards-approve", text: "A routine card: approve it" },
      { id: "cards-left", text: "An unclear card: leave a note for me in Needs you" },
      { id: "cards-risky", text: "A risky request: leave it for me with the reason" },
    ],
    runner: { kind: "chore", chore: "cards" },
  }),
  upkeep({
    id: "upkeep-questions",
    name: "Agents' questions",
    purpose: "Answers an agent's question when the brief or the code settles it.",
    trigger: { cadence: HOURLY, events: ["An agent asks"] },
    inputs: ["Pending questions and permission prompts"],
    steps:
      "Settle a permission prompt by the rule table. Answer a question only when the brief, memory or the code settles it; otherwise leave it.",
    outputs: ["decision", "log"],
    cost: { tier: "small", tokens: PASS_BOUND.tokens },
    turnOn: "Answers agents' questions where Questions is Captain.",
    outcomes: [
      { id: "q-answer", text: "Sure of the answer: answer it" },
      { id: "q-ask", text: "Not sure: ask me" },
    ],
    runner: { kind: "chore", chore: "questions" },
  }),
  upkeep({
    id: "upkeep-memory",
    name: "Memory",
    purpose: "Keeps, merges or drops memories that wait.",
    trigger: { cadence: DAILY, events: ["10 memories wait for review"] },
    inputs: ["Memories waiting for review"],
    steps:
      "Keep a durable, non-obvious fact. Drop a one-off symptom, generic advice or what the docs already say. Merge a copy into the fact it repeats. Leave a contradiction for the owner.",
    outputs: ["log"],
    cost: { tier: "laya", tokens: PASS_BOUND.tokens },
    turnOn: "Reviews waiting memories once a day. It also runs while Auto-pilot is off.",
    outcomes: [
      { id: "mem-keep", text: "A good lesson: keep it" },
      { id: "mem-drop", text: "A duplicate or a wrong one: drop it" },
      { id: "mem-escalate", text: "Not sure: let the small model look first, then ask me" },
    ],
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
    cost: { tier: "rules", tokens: PASS_BOUND.tokens },
    turnOn: "Registers new repos where Upkeep is Captain.",
    outcomes: [
      { id: "proj-register", text: "A new repo in the workspace folder: register it" },
      { id: "proj-cards", text: "Refresh a project card when its base branch moves" },
      { id: "proj-readiness", text: "A readiness gap: file a finding" },
    ],
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
    cost: { tier: "rules", tokens: PASS_BOUND.tokens },
    turnOn: "Triages open tasks once a day where Upkeep is Captain.",
    outcomes: [
      { id: "triage-priority", text: "Due soon: set high priority" },
      { id: "triage-split", text: "A big task: propose subtasks" },
      { id: "triage-duplicate", text: "Same title as another: suggest closing one" },
      { id: "triage-stale", text: "Untouched for 30 days: ask me to close it" },
    ],
    runner: { kind: "chore", chore: "triage" },
  }),
  upkeep({
    id: "upkeep-cleanup",
    name: "Cleanup",
    purpose: "Frees disk from finished tasks. Never uncommitted work.",
    trigger: { cadence: DAILY, events: [] },
    inputs: ["Done tasks and what they left behind"],
    steps:
      "Remove what a done task left behind once it is merged or kept elsewhere. Never remove uncommitted work.",
    outputs: ["log"],
    cost: { tier: "rules", tokens: PASS_BOUND.tokens },
    turnOn: "Cleans up done tasks once a day. It also runs while Auto-pilot is off.",
    outcomes: [
      { id: "cleanup-caches", text: "A done task's rebuildable caches: remove them" },
      { id: "cleanup-worktrees", text: "A merged done task's worktree, after the set days: remove it" },
      { id: "cleanup-ask", text: "Uncommitted changes: ask me, never remove" },
    ],
    runner: { kind: "chore", chore: "cleanup" },
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
    cost: { tier: "laya", tokens: PASS_BOUND.tokens },
    turnOn: "Reads the open follow-ups of memory once a day where Upkeep is Captain.",
    outcomes: [
      { id: "fu-close", text: "A follow-up already done: close it" },
      { id: "fu-finding", text: "The rest: file them as findings" },
      { id: "fu-task", text: "Concrete work: propose a task in the inbox", default: false },
    ],
    runner: { kind: "chore", chore: "followups" },
  }),
  upkeep({
    id: "upkeep-discover",
    name: "Discover tools",
    purpose:
      "Once a day, searches the MCP registry and the skills directory for tools that fit your projects, and proposes the best few.",
    trigger: { cadence: DAILY, events: [] },
    inputs: ["Projects of the workspace", "Connections", "The MCP registry and skills.sh"],
    steps:
      "Read what the workspace's projects use. Search the registry and the directory for each. Propose the top few as findings with the reason. Never propose one you proposed before and the owner turned down. With full access, install a skill (never enabled for any agent) and say so.",
    outputs: ["finding", "log"],
    cost: { tier: "rules", tokens: PASS_BOUND.tokens },
    turnOn: "Looks for useful MCP servers and skills once a day where Upkeep is Captain.",
    outcomes: [
      { id: "disc-propose", text: "A tool that fits a project: propose it in Needs you" },
      { id: "disc-install", text: "Full access and a low-risk skill: install it, tell me" },
    ],
    runner: { kind: "chore", chore: "discover" },
  }),
  upkeep({
    id: "upkeep-tidy",
    name: "Tidy up",
    purpose:
      "Finds stale inbox items, old previews, dead watches and failing connections. Proposes, never deletes.",
    trigger: { cadence: DAILY, events: [] },
    inputs: [
      "Tasks",
      "Previews",
      "Watches",
      "Connections",
      "Worktrees of done tasks",
      "Items waiting for you",
    ],
    steps:
      "Re-test a failing connection. File what is stale as a finding with a proposal to close it. Leave a worktree with uncommitted changes for the owner. Send one summary line.",
    outputs: ["finding", "log"],
    cost: { tier: "rules", tokens: PASS_BOUND.tokens },
    turnOn: "Tidies majhi once a day where Upkeep is Captain. Destructive steps wait for you.",
    outcomes: [
      { id: "tidy-retest", text: "A failing connection: test it again" },
      { id: "tidy-propose", text: "Something stale: propose closing it" },
      {
        id: "tidy-secrets",
        text: "A duplicate or abandoned secret request: withdraw it. The rest: try a connection first",
      },
      { id: "tidy-dirty", text: "A worktree with uncommitted changes: ask me, never remove" },
    ],
    runner: { kind: "chore", chore: "tidy" },
  }),
  upkeep({
    id: "upkeep-health",
    name: "Health sweep",
    purpose: "Runs the health checks, applies the fixes majhi offers itself, and files a bug for the rest.",
    trigger: { cadence: { kind: "every", minutes: 720 }, events: [] },
    inputs: ["The health checks"],
    steps:
      "Run every check. Run the fix of a failed check that has one. File what stays failed as a bug on majhi, or ask the owner when it needs a sign-in or a form.",
    outputs: ["log"],
    cost: { tier: "rules", tokens: PASS_BOUND.tokens },
    turnOn: "Runs the health checks twice a day where Upkeep is Captain.",
    outcomes: [
      { id: "health-fix", text: "A failed check with a fix: run the fix" },
      { id: "health-bug", text: "Still failing: file a bug on majhi" },
    ],
    runner: { kind: "chore", chore: "health" },
  }),
  upkeep({
    id: "upkeep-checklist",
    name: "Owner checklist",
    purpose:
      "Walks through what you are not thinking about: backups, disk, spend, connections, previews and agent slots.",
    trigger: { cadence: DAILY, events: [] },
    inputs: ["Backups", "Disk", "Budgets", "Agent slots"],
    steps:
      "Check that a backup is recent and verified, disk is free, no budget is near its cap, and agents are not stuck waiting for a slot. File each finding once. With full access, raise the slots of an account by one, up to 4, when it has room.",
    outputs: ["finding", "log"],
    cost: { tier: "rules", tokens: PASS_BOUND.tokens },
    turnOn: "Checks what you may not think about once a day where Upkeep is Captain.",
    outcomes: [
      { id: "check-finding", text: "Something is off: file a finding" },
      {
        id: "check-slots",
        text: "Agents wait for a slot and the account has room: raise it by one, up to 4",
      },
    ],
    runner: { kind: "chore", chore: "checklist" },
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
    outcomes: [
      { id: "laya-finding", text: "A decision got worse: file a finding" },
      { id: "laya-backlog", text: "Read a few old findings each week" },
    ],
    runner: { kind: "rules", id: "laya-eval" },
    settings: [],
  },
];

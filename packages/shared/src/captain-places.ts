import type { CommandName } from "./commands.ts";

/**
 * The captain's three places (docs/briefs/captain.md): Needs you (what waits: cards, incidents, client
 * messages), Work (tasks to plan, run, review and ship) and Chat (the owner talks to it). A turn is offered
 * the tools of its place and a small core, not all of majhi's commands. Typed against `CommandName`, so a
 * removed command fails to compile; a command in no place is not offered to the captain (the owner has it in
 * Settings, or the captain files the gap with `captain.reportBug`).
 */
export const CAPTAIN_PLACES = ["needs", "work", "chat"] as const;
export type CaptainPlace = (typeof CAPTAIN_PLACES)[number];

/** In every turn: reading what the owner sees, remembering, asking a workspace's step, reporting a bug. */
const CORE: readonly CommandName[] = [
  "tasks.list",
  "tasks.get",
  "tasks.report",
  "tasks.plan",
  "tasks.slots",
  "tasks.blockers",
  "decisions.list",
  "decisions.detail",
  "decisions.recommend",
  "wiki.ask",
  "memory.search",
  "memory.add",
  "memory.closeThread",
  "projects.list",
  "projects.cards",
  "orgs.list",
  "accounts.list",
  "usage.summary",
  "budgets.status",
  "ops.overview",
  "watch.overview",
  "captain.status",
  "captain.log",
  "captain.step",
  "captain.reportBug",
  "autonomy.status",
  "autonomy.note",
  "chat.history",
  "findings.list",
  "agents.list",
  "uploads.create",
];

/** Playbook runs, goals and outbound drafts: the tools of a playbook turn, which the captain runs in a lane. */
const PLAYBOOKS: readonly CommandName[] = [
  "findings.report",
  "playbooks.list",
  "playbooks.runs",
  "playbooks.activity",
  "playbooks.report",
  "goals.list",
  "goals.create",
  "goals.update",
  "outbound.list",
  "outbound.submit",
  "scorecard.get",
  "trust.list",
];

/** Tasks to start, steer and look at: shared by the places that act on work. */
const TASK_BASICS: readonly CommandName[] = [
  "tasks.create",
  "tasks.start",
  "tasks.stop",
  "tasks.update",
  "tasks.tell",
  "tasks.diff",
  "tasks.close",
  "tasks.reopen",
];

/** What waits for the owner: incidents, client chats, findings, cards, signals. */
const NEEDS: readonly CommandName[] = [
  ...TASK_BASICS,
  ...PLAYBOOKS,
  "autonomy.answer",
  "ops.ack",
  "ops.checkNow",
  "incident.cause",
  "chat.reply",
  "chat.openIncident",
  "case.status",
  "case.followUp",
  "case.ask",
  "case.close",
  "case.stop",
  "chat.startTask",
  "findings.toTask",
  "findings.update",
  "findings.dismiss",
  "watch.plan",
  "watch.test",
  "watch.save",
  "watch.checkNow",
  "connections.list",
  "connections.get",
  "connections.test",
  "toolbox.list",
  "toolbox.install",
  "tasks.resolveShip",
  "projects.register",
];

/** Planning, running, reviewing and shipping tasks. */
const WORK: readonly CommandName[] = [
  ...TASK_BASICS,
  ...PLAYBOOKS,
  "autonomy.plan",
  "autonomy.answer",
  "findings.toTask",
  "tasks.split",
  "tasks.setType",
  "tasks.setFields",
  "tasks.changed",
  "tasks.look",
  "tasks.merge",
  "tasks.push",
  "tasks.openMrs",
  "tasks.mergeMrs",
  "tasks.markMerged",
  "tasks.resolveShip",
  "tasks.queueMerge",
  "tasks.shipOptions",
  "tasks.refreshMrs",
  "tasks.link",
  "tasks.unlink",
  "team.add",
  "team.swap",
  "projects.register",
  "projects.planDeploy",
  "handoff.get",
  "handoff.check",
  "handoff.rerun",
  "containers.list",
];

/** The owner talks to it: everything a turn may need to answer or act, and the switch it can propose. */
const CHAT_ONLY: readonly CommandName[] = ["autonomy.start", "brief.list", "connections.setSecret"];

const PLACES: Record<CaptainPlace, readonly CommandName[]> = {
  needs: [...CORE, ...NEEDS],
  work: [...CORE, ...WORK],
  chat: [...CORE, ...NEEDS, ...WORK, ...CHAT_ONLY],
};

/** The commands a turn in this place is offered as tools. */
export function placeCommands(place: CaptainPlace): ReadonlySet<CommandName> {
  return new Set(PLACES[place]);
}

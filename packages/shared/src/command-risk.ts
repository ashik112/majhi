import { approvalGroupOf } from "./approval-groups.ts";
import { type CommandName, commands } from "./commands.ts";
import type { RiskKind } from "./risk-kinds.ts";

/** The risk of each majhi command (docs/briefs/workflow-reset.md, step 1b). Kinds and levels are in `risk-kinds.ts`. */

/** What shipping, deploying, telling and secrets commands are, by name. Everything else follows its group and class. */
const COMMAND_RISK: Partial<Record<CommandName, RiskKind>> = {
  "tasks.push": "push-branch",
  "tasks.openMrs": "push-branch",
  "tasks.merge": "merge-main",
  "tasks.mergeMrs": "merge-main",
  "tasks.markMerged": "merge-main",
  "tasks.resolveShip": "merge-main",
  "tasks.queueMerge": "merge-main",
  "projects.deploy": "deploy-production",
  "projects.rollback": "deploy-production",
  "projects.publish": "client-server-write",
  "projects.connectRemote": "client-server-write",
  "chat.send": "client-message",
  "chat.sendAs": "client-message",
  "chat.retryReply": "client-message",
  "chat.editReply": "client-message",
  "incident.sendReport": "client-message",
  "outbound.submit": "client-message",
  "outbound.decide": "client-message",
  "outbound.decideBatch": "client-message",
  "secrets.save": "secret",
  "secrets.remove": "secret",
  "secrets.exportKey": "secret",
  "secrets.restoreKey": "secret",
  "room.secret": "secret",
  "connections.setSecret": "secret",
  "connections.setFile": "secret",
  "git.signIn.token": "secret",
};

/** Bookkeeping that lives in majhi and touches nothing outside it: notes, findings, memory, the wiki. */
const BOOKKEEPING: ReadonlySet<CommandName> = new Set<CommandName>([
  "memory.add",
  "memory.edit",
  "memory.pin",
  "memory.extract",
  "memory.closeThread",
  "memory.reopenThread",
  "wiki.update",
  "findings.report",
  "findings.update",
  "findings.dismiss",
  "playbooks.report",
  "decisions.recommend",
  "watch.report",
  "ops.ack",
]);

/** The risk of a card action on a review or paused card, by what the action does. */
function cardActionRisk(action: unknown): RiskKind {
  if (action === "merge" || action === "mergePush") return "merge-main";
  if (action === "push" || action === "mr") return "push-branch";
  return "sandbox";
}

/**
 * The risk of a majhi command. Reads are sandbox. Shipping, deploying, telling and secret commands are
 * listed by name; the task and preview groups are sandbox, the deleting group deletes outside; the rest
 * (projects, accounts, settings) stay `other`, which the owner's approval modes decide. A command nobody
 * classified is `other`, so a new command asks until it is placed.
 */
export function commandRisk(name: string, input?: Record<string, unknown>): RiskKind {
  if (!Object.hasOwn(commands, name)) return "other";
  const command = name as CommandName;
  if (command === "room.cardAction") return cardActionRisk(input?.action);
  const named = COMMAND_RISK[command];
  if (named !== undefined) return named;
  const def = commands[command];
  if (def.risk === "read") return "sandbox";
  if (def.risk === "destructive") return "delete-outside";
  if (BOOKKEEPING.has(command)) return "sandbox";
  switch (approvalGroupOf(command)) {
    case "bookkeeping":
    case "previews":
    case "shipping":
      return "sandbox";
    case "deleting":
      return "delete-outside";
    default:
      return "other";
  }
}

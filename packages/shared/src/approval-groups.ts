import { z } from "zod";
import { type CommandName, commands, isDestructiveCommand, type RiskClass } from "./commands.ts";
import type { ApprovalMode, PolicySettings } from "./settings.ts";

/**
 * The approval page's plain categories of the commands agents can call (5.16). The server and the
 * web read the same lists. A command missing from every list lands in `other`, so a new command
 * always shows somewhere without anyone editing this file.
 */

/** Commands an agent never calls: they approve, answer or reach outside majhi for the owner. */
export const AGENT_BLOCKED_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  "room.approve",
  "room.secret",
  "policy.set",
  "policy.removeRule",
  "permissions.list",
  "permissions.revoke",
  "room.permission",
  "room.choose",
  "room.send",
  "room.cancel",
  "room.fresh",
  "ssh.unlock",
  "secrets.exportKey",
  "secrets.restoreKey",
  "boss.chat",
  // Read state is the owner's: what they have seen is not for an agent to read or move.
  "conversations.list",
  "conversations.markRead",
  "chats.create",
  "chats.rename",
  // Autonomous mode is the owner's switch: the captain never turns it on, widens its limits or guides itself.
  "autonomy.start",
  "autonomy.pause",
  "autonomy.stop",
  "autonomy.configure",
  "autonomy.guide",
  "autonomy.forget",
  "autonomy.exclude",
  // The captain never stops or resumes itself, undoes its own log or turns its chores back on.
  "captain.stop",
  "captain.resume",
  "captain.undo",
  "captain.choreOn",
  "captain.runChore",
  "captain.answerBudget",
  // The decisions inbox answers for the owner: the owner's click only.
  "decisions.answer",
  "decisions.answerBatch",
  // A restore replaces the whole database: the owner's call.
  "backup.restore",
  "backup.cancelRestore",
  // Where backups are written is the owner's choice: a synced folder carries them off this computer.
  "backup.setDestination",
  // Git sign-in happens in the owner's browser or with a token the owner pastes: the owner's alone.
  "git.oauthApps.set",
  "git.signIn.start",
  "git.signIn.poll",
  "git.signIn.cancel",
  "git.signIn.confirm",
  "git.signIn.token",
  "git.signOut",
]);

export const ApprovalGroupIdSchema = z.enum([
  "bookkeeping",
  "previews",
  "projects",
  "accounts",
  "shipping",
  "deleting",
  "other",
]);
export type ApprovalGroupId = z.infer<typeof ApprovalGroupIdSchema>;

interface GroupDef {
  label: string;
  about: string;
  /** In display order. `other` lists nothing here: it takes every command no other group has. */
  commands: readonly CommandName[];
}

export const APPROVAL_GROUP_DEFS: Record<ApprovalGroupId, GroupDef> = {
  bookkeeping: {
    label: "Task bookkeeping",
    about:
      "File, split, start, stop, update, link and close tasks, update a local branch from its remote, and add or swap team members.",
    commands: [
      "tasks.create",
      "tasks.split",
      "tasks.start",
      "tasks.stop",
      "tasks.update",
      "tasks.link",
      "tasks.unlink",
      "tasks.close",
      "tasks.reopen",
      "tasks.refreshMrs",
      "tasks.updateTarget",
      "tasks.syncBase",
      "projects.fetch",
      "team.add",
      "tasks.addAgent",
      "tasks.tell",
      "tasks.setLead",
      "team.swap",
      "team.set",
    ],
  },
  previews: {
    label: "Previews and processes",
    about: "Build and run previews, start test services, stop containers and processes.",
    commands: [
      "containers.preview.build",
      "containers.preview.run",
      "containers.services.start",
      "containers.stop",
      "processes.stop",
      "tasks.terminal.open",
    ],
  },
  projects: {
    label: "Projects",
    about:
      "Register, clone or create a project, put a new one on its git host, or change where a project's code goes.",
    commands: [
      "projects.register",
      "projects.update",
      "projects.clone",
      "projects.create",
      "projects.publish",
      "projects.connectRemote",
      "workspaces.set",
      "tasks.changeBranch",
    ],
  },
  accounts: {
    label: "Orgs, git accounts and secrets",
    about:
      "Org settings, git accounts and tokens, saved logins, accounts, connections, secrets, skills and MCP servers (code that runs in agent runs).",
    commands: [
      "orgs.create",
      "orgs.update",
      "orgs.rename",
      "orgs.setGitAccount",
      "orgs.useGitLogin",
      "orgs.useSavedLogin",
      "accounts.create",
      "accounts.login.start",
      "accounts.hideModel",
      "secrets.save",
      "connections.create",
      "connections.update",
      "connections.setSecret",
      "connections.setFile",
      "connections.allow",
      "skills.install",
      "skills.update",
      "skills.enable",
      "skills.enableAll",
      "skills.disable",
      "skills.setMany",
      "mcp.install",
      "mcp.enable",
      "mcp.disable",
      "ssh.reload",
    ],
  },
  shipping: {
    label: "Shipping",
    about: "Merge, push and open or merge merge requests: code leaves the task branch.",
    commands: [
      "tasks.merge",
      "tasks.push",
      "tasks.openMrs",
      "tasks.mergeMrs",
      "tasks.resolveShip",
      "tasks.cancelShip",
      "tasks.queueMerge",
      "tasks.cancelQueuedMerge",
      "tasks.setMergeOrder",
      "tasks.markMerged",
      "room.cardAction",
    ],
  },
  deleting: {
    label: "Deleting",
    about: "Remove tasks, agents, accounts, projects, secrets, schedules and memory.",
    commands: [
      "tasks.remove",
      "cleanup.run",
      "team.remove",
      "tasks.removeAgent",
      "agents.remove",
      "accounts.remove",
      "projects.remove",
      "orgs.removeGitAccount",
      "secrets.remove",
      "connections.remove",
      "skills.remove",
      "containers.images.remove",
      "schedules.delete",
      "triggers.delete",
      "memory.forget",
    ],
  },
  other: {
    label: "Other changes",
    about: "Everything else: agents, memory, schedules and triggers, settings and the rest.",
    commands: [],
  },
};

export const APPROVAL_GROUP_IDS: readonly ApprovalGroupId[] = ApprovalGroupIdSchema.options;

/**
 * Commands that change where code goes or as whom, or what agents can reach. The page marks them so
 * the owner sees them before a bulk change.
 */
export const SENSITIVE_COMMANDS: ReadonlySet<string> = new Set<CommandName>([
  "projects.update",
  "workspaces.set",
  "tasks.changeBranch",
  "orgs.setGitAccount",
  "orgs.useGitLogin",
  "orgs.useSavedLogin",
  "orgs.removeGitAccount",
  "projects.publish",
  "projects.connectRemote",
  "connections.allow",
  "skills.install",
  "skills.update",
  "mcp.install",
  "containers.images.allow",
  "system.update",
]);

/** The command in words, as the approval page lists it. */
const LABELS: Partial<Record<CommandName, string>> = {
  "tasks.create": "Create a task",
  "tasks.split": "Split a task",
  "tasks.start": "Start a task",
  "tasks.stop": "Stop a task",
  "tasks.update": "Update a task",
  "tasks.link": "Link two tasks",
  "tasks.unlink": "Unlink two tasks",
  "tasks.close": "Close a task",
  "tasks.reopen": "Reopen a task",
  "tasks.refreshMrs": "Check a task's merge requests",
  "team.add": "Add an agent to a team",
  "tasks.addAgent": "Add an agent to a task",
  "tasks.tell": "Write to a task's lead as the captain",
  "tasks.setLead": "Hand a task to another lead",
  "team.swap": "Swap an agent in a team",
  "team.set": "Set an agent's model or effort for a task",
  "containers.preview.build": "Build a preview",
  "containers.preview.run": "Run a preview",
  "containers.services.start": "Start a test service",
  "containers.stop": "Stop a preview or service",
  "processes.stop": "Stop a background process",
  "tasks.terminal.open": "Open a task's terminal",
  "projects.register": "Register a project",
  "projects.update": "Change a project: remote, base, SSH alias",
  "projects.clone": "Clone a repo into a workspace",
  "projects.create": "Create a new local project",
  "projects.publish": "Create a project's repo on its git host and push",
  "projects.connectRemote": "Connect a project to a remote repo and push",
  "workspaces.set": "Change the workspace roots",
  "tasks.changeBranch": "Commit to another task's branch",
  "orgs.create": "Create an org",
  "orgs.update": "Change an org's settings",
  "orgs.rename": "Rename an org",
  "orgs.setGitAccount": "Set an org's git account",
  "orgs.useGitLogin": "Use this computer's gh or glab login",
  "orgs.useSavedLogin": "Use a saved git login",
  "accounts.create": "Add an account",
  "accounts.login.start": "Start an account login",
  "accounts.hideModel": "Hide or show an account's model",
  "secrets.save": "Save a secret",
  "connections.create": "Add a connection",
  "connections.update": "Change a connection",
  "connections.setSecret": "Set a connection's secret",
  "connections.setFile": "Set a connection's file",
  "connections.allow": "Allow writes on a connection",
  "skills.install": "Install a skill",
  "skills.update": "Update a skill",
  "skills.enable": "Turn a skill on for an agent",
  "skills.enableAll": "Turn a skill on for every agent",
  "skills.disable": "Turn a skill off for an agent",
  "skills.setMany": "Turn several skills on or off for agents or a workspace",
  "mcp.install": "Install an MCP server",
  "mcp.enable": "Turn an MCP server on for an agent",
  "mcp.disable": "Turn an MCP server off for an agent",
  "ssh.reload": "Reload SSH keys",
  "tasks.merge": "Merge a task into a local branch",
  "tasks.push": "Push a task branch",
  "tasks.openMrs": "Open merge requests",
  "tasks.mergeMrs": "Merge merge requests on the host",
  "tasks.resolveShip": "Ask the lead to resolve merge conflicts",
  "tasks.cancelShip": "Cancel a waiting ship",
  "tasks.queueMerge": "Merge when the checks pass",
  "tasks.cancelQueuedMerge": "Cancel a merge that waits for the checks",
  "tasks.setMergeOrder": "Set the merge order",
  "tasks.markMerged": "Mark merge requests merged",
  "tasks.updateTarget": "Update a local target branch",
  "tasks.syncBase": "Update task branch from base",
  "projects.fetch": "Fetch a project from its remote",
  "room.cardAction": "Act on a review card",
  "tasks.remove": "Remove a task",
  "cleanup.run": "Clean up done tasks",
  "team.remove": "Take an agent off a team",
  "tasks.removeAgent": "Take an agent off a task",
  "agents.remove": "Delete an agent",
  "accounts.remove": "Remove an account",
  "projects.remove": "Unregister a project",
  "orgs.removeGitAccount": "Remove an org's git account",
  "secrets.remove": "Delete a secret",
  "connections.remove": "Remove a connection",
  "skills.remove": "Remove a skill",
  "containers.images.remove": "Stop allowing a service image",
  "schedules.delete": "Delete a schedule",
  "triggers.delete": "Delete a watch trigger",
  "memory.forget": "Retire a memory fact",
  "workspaces.remount": "Remount the workspace roots",
  "editor.open": "Open something in your editor",
  "notify.test": "Send a test notification",
  "agents.create": "Create an agent",
  "agents.update": "Replace an agent's settings",
  "agents.edit": "Edit an agent",
  "agents.duplicate": "Copy an agent",
  "agents.rename": "Rename an agent",
  "boss.set": "Choose the captain",
  "room.answerQuestion": "Answer a question card",
  "room.answerAsk": "Answer an ask card",
  "containers.images.allow": "Allow a service image",
  "history.undo": "Undo a config change",
  "settings.set": "Change hub settings",
  "cleanup.preview": "Preview a cleanup",
  "health.fix": "Run a health fix",
  "projects.cardRefresh": "Refresh a project card",
  "system.update": "Rebuild and restart majhi",
  "decisions.correct": "Correct a decision",
  "decisions.set": "Change decision settings",
  "decisions.install": "Install Laya",
  "memory.add": "Add a memory fact",
  "memory.edit": "Edit a memory fact",
  "memory.approve": "Approve a memory fact",
  "memory.reject": "Reject a memory fact",
  "memory.pin": "Pin a memory fact",
  "memory.undo": "Undo a memory step",
  "memory.extract": "Read a room for memory",
  "memory.promote": "Add a fact to AGENTS.md",
  "memory.approveAll": "Approve pending facts",
  "memory.rejectAll": "Reject pending facts",
  "memory.restoreBrief": "Restore a project brief",
  "memory.buildBrief": "Rebuild a project brief",
  "memory.closeThread": "Close a memory thread",
  "memory.reopenThread": "Reopen a memory thread",
  "usage.setPrice": "Set a model's price",
  "schedules.create": "Create a schedule",
  "schedules.update": "Change a schedule",
  "schedules.pause": "Pause a schedule",
  "schedules.resume": "Resume a schedule",
  "schedules.runNow": "Run a schedule now",
  "triggers.create": "Create a watch trigger",
  "triggers.update": "Change a watch trigger",
  "triggers.pause": "Pause a watch trigger",
  "triggers.resume": "Resume a watch trigger",
  "triggers.runNow": "Run a watch trigger now",
};

const GROUP_OF = new Map<string, ApprovalGroupId>(
  APPROVAL_GROUP_IDS.flatMap((id) => APPROVAL_GROUP_DEFS[id].commands.map((c) => [c, id] as const)),
);

/** The category a command shows under. Anything not listed is an "Other change". */
export function approvalGroupOf(command: string): ApprovalGroupId {
  return GROUP_OF.get(command) ?? "other";
}

/** A command in words: its label, else the first clause of its summary, else its name. */
export function commandLabel(command: string): string {
  const label = Object.hasOwn(LABELS, command) ? LABELS[command as CommandName] : undefined;
  if (label !== undefined) return label;
  const def = Object.hasOwn(commands, command) ? commands[command as CommandName] : undefined;
  if (def === undefined) return command;
  const first = def.summary.split(/[.:(]/)[0]?.trim() ?? "";
  return first === "" ? command : first;
}

export interface ApprovalCommand {
  name: string;
  label: string;
  risk: RiskClass;
  sensitive: boolean;
}

export interface ApprovalGroup {
  id: ApprovalGroupId;
  label: string;
  about: string;
  commands: ApprovalCommand[];
}

/**
 * Every command that can put an approval card in front of the owner (agents may call it and it is
 * not a read), in its category. Derived from `commands`, so the list never goes stale.
 */
export function approvalGroups(): ApprovalGroup[] {
  const cardable = (Object.keys(commands) as CommandName[]).filter(
    (name) => commands[name].risk !== "read" && !AGENT_BLOCKED_COMMANDS.has(name),
  );
  const item = (name: CommandName): ApprovalCommand => ({
    name,
    label: commandLabel(name),
    risk: commands[name].risk,
    sensitive: SENSITIVE_COMMANDS.has(name),
  });
  const listed = new Set(cardable);
  return APPROVAL_GROUP_IDS.map((id) => {
    const def = APPROVAL_GROUP_DEFS[id];
    const names =
      id === "other"
        ? cardable.filter((n) => approvalGroupOf(n) === "other")
        : def.commands.filter((n) => listed.has(n));
    return { id, label: def.label, about: def.about, commands: names.map(item) };
  });
}

// -----------------------------------------------------------------------------
// The owner's draft of the policy: what each command would do, presets and the change list.

/** The part of the policy the approval page edits. Rules and the destructive toggle are elsewhere. */
export type PolicyModes = Pick<PolicySettings, "read" | "change" | "destructive" | "outbound" | "commands">;

/**
 * What a command does under these modes: its own setting, else its risk class. A destructive command
 * always waits for the owner's click, whatever the modes say.
 */
/**
 * Commands that change what an agent may do or reach: approvals, autonomy and the captain's own
 * switches, spend and trust ceilings, agents' permissions and accounts, secrets and sign-ins, and who
 * gets a connection or server. Full access never covers them: they always follow the owner's policy.
 */
export const PERMISSION_COMMANDS: ReadonlySet<string> = new Set([
  "policy.set",
  "policy.removeRule",
  "settings.set",
  "history.undo",
  "autonomy.start",
  "autonomy.pause",
  "autonomy.stop",
  "autonomy.configure",
  "autonomy.exclude",
  "captain.stop",
  "captain.resume",
  "captain.choreOn",
  "captain.answerBudget",
  "money.set",
  "trust.unmute",
  "trust.setWindow",
  "scorecard.setMinutes",
  "agents.create",
  "agents.update",
  "agents.edit",
  "agents.duplicate",
  "agents.rename",
  "agents.remove",
  "secrets.save",
  "secrets.remove",
  "secrets.exportKey",
  "secrets.restoreKey",
  "orgs.useGitLogin",
  "orgs.useSavedLogin",
  "orgs.setGitAccount",
  "orgs.removeGitAccount",
  "connections.allow",
  "connections.setSecret",
  "mcp.enable",
  "mcp.disable",
]);

export function effectiveMode(policy: PolicyModes, command: string, risk: RiskClass): ApprovalMode {
  if (isDestructiveCommand(command)) return "confirm";
  return policy.commands[command] ?? policy[risk];
}

/**
 * Sets one command's mode. A mode equal to its risk class drops the override, so majhi.yaml lists
 * only the commands that differ.
 */
export function withCommandMode(
  policy: PolicyModes,
  command: string,
  risk: RiskClass,
  mode: ApprovalMode,
): PolicyModes {
  const { [command]: _old, ...rest } = policy.commands;
  const own = mode !== policy[risk] && !isDestructiveCommand(command);
  return { ...policy, commands: own ? { ...rest, [command]: mode } : rest };
}

export const ApprovalPresetIdSchema = z.enum(["hands-off", "careful"]);
export type ApprovalPresetId = z.infer<typeof ApprovalPresetIdSchema>;

export const APPROVAL_PRESETS: Record<ApprovalPresetId, { label: string; about: string }> = {
  "hands-off": {
    label: "Hands-off",
    about:
      "Agents run their own task work. They ask you before shipping, deleting, or touching git accounts, secrets or project remotes.",
  },
  careful: {
    label: "Careful",
    about: "Agents ask you before anything that changes.",
  },
};

/** The modes a preset gives, starting from `from`. Commands the preset does not name keep theirs. */
export function applyPreset(
  from: PolicyModes,
  preset: ApprovalPresetId,
  groups: ApprovalGroup[],
): PolicyModes {
  if (preset === "careful") {
    // Every change asks: the risk classes say so, and no command keeps its own setting.
    let next: PolicyModes = { ...from, change: "confirm", destructive: "confirm", outbound: "confirm" };
    for (const g of groups)
      for (const c of g.commands) next = withCommandMode(next, c.name, c.risk, "confirm");
    return next;
  }
  const modeOf = (group: ApprovalGroupId, command: string): ApprovalMode | undefined => {
    switch (group) {
      case "bookkeeping":
      case "previews":
        return "auto";
      case "projects":
        return command === "projects.register" ? "auto" : "confirm";
      case "accounts":
      case "shipping":
      case "deleting":
        return "confirm";
      case "other":
        return undefined;
    }
  };
  let next = from;
  for (const g of groups) {
    for (const c of g.commands) {
      const mode = modeOf(g.id, c.name);
      if (mode !== undefined) next = withCommandMode(next, c.name, c.risk, mode);
    }
  }
  return next;
}

export interface ModeChange {
  command: string;
  label: string;
  group: ApprovalGroupId;
  from: ApprovalMode;
  to: ApprovalMode;
}

/** Each listed command whose mode differs between `before` and `after`, in page order. */
export function policyChanges(
  before: PolicyModes,
  after: PolicyModes,
  groups: ApprovalGroup[],
): ModeChange[] {
  const out: ModeChange[] = [];
  for (const g of groups) {
    for (const c of g.commands) {
      const from = effectiveMode(before, c.name, c.risk);
      const to = effectiveMode(after, c.name, c.risk);
      if (from !== to) out.push({ command: c.name, label: c.label, group: g.id, from, to });
    }
  }
  return out;
}

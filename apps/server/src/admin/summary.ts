import { type CommandName, commands } from "@majhi/shared";
import { redactText } from "./policy.ts";

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One line in plain words for the approval card, from the command and its input. */
const TEMPLATES: Partial<Record<CommandName, (i: Input) => string>> = {
  "orgs.create": (i) => `Create org ${str(i.name) || str(i.id)}${i.key ? ` (key ${str(i.key)})` : ""}`,
  "orgs.update": (i) => `Change org ${str(i.id)}`,
  "orgs.rename": (i) => `Rename org ${str(i.id)} to ${str(i.newId)}`,
  "agents.rename": (i) => `Rename agent ${str(i.id)} to ${str(i.newId)}`,
  "tasks.update": (i) => `Edit task ${str(i.id)}`,
  "accounts.create": (i) => `Add ${str(i.tool)} account ${str(i.id)} for ${str(i.org)}`,
  "accounts.remove": (i) => `Remove account ${str(i.id)}`,
  "accounts.hideModel": (i) =>
    `${i.hidden === true ? "Hide" : "Show"} ${str(i.model)} on account ${str(i.id)}`,
  "accounts.login.start": (i) => `Start sign-in for account ${str(i.id)}`,
  "tasks.terminal.open": (i) => `Open a terminal in the folder of task ${str(i.task)}`,
  "agents.create": (i) => `Create agent ${str(i.id)}`,
  "agents.update": (i) => `Change agent ${str(i.id)}`,
  "agents.duplicate": (i) => `Copy agent ${str(i.id)} as ${str(i.newId)}`,
  "agents.remove": (i) => `Delete agent ${str(i.id)}`,
  "boss.set": (i) => `Make ${str(i.id)} the boss`,
  "projects.register": (i) => `Register project ${str(i.id)} for ${str(i.org)}`,
  "projects.update": (i) => `Change project ${str(i.id)}`,
  "projects.remove": (i) => `Unregister project ${str(i.id)}`,
  "tasks.create": (i) => `Create a task: ${firstLine(str(i.text))}`,
  "tasks.remove": (i) => `Delete task ${str(i.id)}`,
  "tasks.start": (i) => `Start ${str(i.id)}`,
  "tasks.stop": (i) => `Stop ${str(i.id)}`,
  "tasks.close": (i) => `Mark ${str(i.id)} done`,
  "tasks.reopen": (i) => `Reopen ${str(i.id)}`,
  "tasks.merge": (i) =>
    `${i.method === "squash" ? "Squash" : i.method === "rebase" ? "Rebase and merge" : "Merge"} ${str(i.id)} into ${
      str(i.into) || "its base"
    }${i.push === true ? " and push" : ""}${i.done === true ? ", then mark it done" : ""}${
      i.deleteAfter === true ? ", then delete the local branch and worktree" : ""
    }`,
  "tasks.push": (i) =>
    `Push the branch of ${str(i.id)}${i.deleteAfter === true ? ", then delete the local branch and worktree" : ""}`,
  "tasks.openMrs": (i) => `Open merge requests for ${str(i.id)}`,
  "tasks.mergeMrs": (i) => `Merge the merge requests of ${str(i.id)}`,
  "tasks.markMerged": (i) => `Record the merge requests of ${str(i.id)} as merged`,
  "tasks.split": (i) => `Split ${str(i.task)} into subtasks`,
  "team.add": (i) => `Add ${str(i.agent)} to ${str(i.task)}`,
  "team.remove": (i) => `Remove ${str(i.agent)} from ${str(i.task)}`,
  "processes.stop": (i) => `Stop ${str(i.id)} in ${str(i.task)}`,
  "secrets.remove": (i) => `Delete secret ${str(i.name)}`,
  "secrets.save": (i) => `Save a secret${i.name ? ` as ${str(i.name)}` : ""}`,
  "history.undo": (i) => `Undo change ${str(i.commit).slice(0, 7)}`,
  "workspaces.set": () => "Change the workspace roots",
  "settings.set": () => "Change settings",
  "containers.images.allow": (i) => `Allow image ${str(i.image)} for service containers`,
  "containers.images.remove": (i) => `Stop allowing image ${str(i.image)} for service containers`,
  "containers.preview.build": (i) => `Build the preview of ${str(i.task)}`,
  "containers.preview.run": (i) => `Run the preview of ${str(i.task)} on port ${str(i.port)}`,
  "containers.services.start": (i) => `Start service ${str(i.name)} (${str(i.image)}) in ${str(i.task)}`,
  "containers.stop": (i) => `Stop ${str(i.name)} in ${str(i.task)}`,
};

/** A command's own summary up to its first full stop: the rest explains, a card only names. */
function firstSentence(text: string): string {
  const end = text.indexOf(". ");
  return end === -1 ? text : text.slice(0, end);
}

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export function summarize(command: CommandName, input: unknown): string {
  const record: Input = typeof input === "object" && input !== null ? (input as Input) : {};
  const template = TEMPLATES[command];
  const text = template === undefined ? firstSentence(commands[command].summary) : template(record);
  return redactText(text.trim());
}

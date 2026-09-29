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
  "accounts.login.start": (i) => `Start sign-in for account ${str(i.id)}`,
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
  "secrets.remove": (i) => `Delete secret ${str(i.name)}`,
  "secrets.save": (i) => `Save a secret${i.name ? ` as ${str(i.name)}` : ""}`,
  "history.undo": (i) => `Undo change ${str(i.commit).slice(0, 7)}`,
  "workspaces.set": () => "Change the workspace roots",
  "settings.set": () => "Change settings",
};

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export function summarize(command: CommandName, input: unknown): string {
  const record: Input = typeof input === "object" && input !== null ? (input as Input) : {};
  const template = TEMPLATES[command];
  const text = template === undefined ? commands[command].summary : template(record);
  return redactText(text.trim());
}

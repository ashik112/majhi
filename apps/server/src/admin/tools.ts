import {
  AGENT_BLOCKED_COMMANDS,
  CAPTAIN_PROPOSALS,
  type CommandName,
  commands,
  type RiskClass,
} from "@majhi/shared";
import { z } from "zod";
import { CLIPBOARD_COPY_TOOL } from "./clipboard-copy.ts";
import { SAVE_FROM_SCRIPT_TOOL, WITHDRAW_SECRET_TOOL } from "./fetch-secret.ts";

/** Commands an agent must never call: they approve, answer or reach outside majhi for the owner. */
export const NOT_TOOLS: ReadonlySet<CommandName> = AGENT_BLOCKED_COMMANDS;

export const REQUEST_SECRET_TOOL = "majhi_request_secret";

export interface AdminTool {
  name: string;
  command: CommandName | undefined;
  risk: RiskClass | undefined;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export function toolName(command: string): string {
  return `majhi_${command.replaceAll(".", "_")}`;
}

const EXTRA_PROPERTIES = {
  ownerAsked: {
    type: "boolean",
    description: "true only if the owner asked for this in the conversation",
  },
  reason: { type: "string", description: "Why you are calling this, in one plain sentence" },
} as const;

/**
 * Inputs only the owner gives, left out of an agent's tool: agents never push, and never force a
 * task's removal over uncommitted work. `refuseForAgents` refuses them if sent anyway.
 */
export const OWNER_ONLY_INPUTS: Partial<Record<CommandName, readonly string[]>> = {
  "tasks.merge": ["push"],
  "tasks.remove": ["force", "confirm"],
  "tasks.removeRepo": ["discard"],
  // Reaching a private network address is the owner's choice: agents never see or set it.
  "git.signIn.start": ["allowPrivate"],
  "git.signIn.token": ["allowPrivate"],
  "connections.connectToken": ["allowPrivate"],
  "connections.probeMcp": ["allowPrivate"],
  "connections.connectMcpUrl": ["allowPrivate"],
  "connect.start": ["allowPrivate"],
};

/**
 * What the captain is told about the commands it may only propose: the call does not run, it becomes a card
 * the owner applies with one click.
 */
const PROPOSE_NOTE: Partial<Record<CommandName, string>> = {
  "autonomy.start":
    " The captain in its workspace lane only. This does not run: it proposes the change, the owner applies it with one click. Nothing changes until then.",
  "autonomy.configure":
    " The captain in its workspace lane only, for its own workspace (orgs.<its id> and nothing else). This does not run: it proposes the change, the owner applies it with one click. Nothing changes until then.",
  "chat.settingsSet":
    " The captain in its workspace lane only, for a client chat of its own workspace. This does not run: it proposes the change, the owner applies it with one click. Nothing changes until then.",
  "projects.setEnvironments":
    " A change you may not make alone (a staging tier, removing a production environment) does not run: it is proposed to the owner, who applies it with one click.",
};

function commandSchema(command: CommandName): AdminTool["inputSchema"] {
  const schema = z.toJSONSchema(commands[command].input, { io: "input", unrepresentable: "any" });
  const { $schema: _dropped, ...rest } = schema as Record<string, unknown>;
  const hidden = new Set(OWNER_ONLY_INPUTS[command] ?? []);
  const properties = Object.fromEntries(
    Object.entries((rest.properties ?? {}) as Record<string, unknown>).filter(([k]) => !hidden.has(k)),
  );
  const required = (Array.isArray(rest.required) ? (rest.required as string[]) : []).filter(
    (k) => !hidden.has(k),
  );
  return {
    ...rest,
    type: "object",
    // A command's own `reason` keeps its description; the extras fill in only what it lacks.
    properties: { ...EXTRA_PROPERTIES, ...properties },
    // A command can already require `reason`: a repeated name makes the schema invalid and the client drops the tool.
    required: [...new Set([...required, "ownerAsked", "reason"])],
  };
}

/** One tool per command that makes sense for an agent, plus `majhi_request_secret`. */
export function adminTools(): AdminTool[] {
  const tools: AdminTool[] = (Object.keys(commands) as CommandName[])
    .filter((name) => !NOT_TOOLS.has(name) || CAPTAIN_PROPOSALS.has(name))
    .map((command) => {
      const def = commands[command];
      return {
        name: toolName(command),
        command,
        risk: def.risk,
        description: `${def.summary}. Risk: ${def.risk}.${PROPOSE_NOTE[command] ?? ""}`,
        inputSchema: commandSchema(command),
      };
    });
  tools.push({
    name: REQUEST_SECRET_TOOL,
    command: undefined,
    risk: undefined,
    description:
      "Ask the owner for a secret (an API key or token). The owner pastes it into a secure field, not the chat. You get only its reference, secret:<name>. Never ask for secrets in chat.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase id for the secret, like newrelic-acme" },
        label: { type: "string", description: "What to paste, in plain words" },
      },
      required: ["name", "label"],
    },
  });
  tools.push(
    {
      name: SAVE_FROM_SCRIPT_TOOL,
      command: undefined,
      risk: undefined,
      description:
        "The captain in its lane only. Fetch a secret through the workspace's connections without the value passing through chat: runs a short read-only script in the runner with the named connections (like doctl with the DigitalOcean connection) and saves what it prints straight into the secret store. A script that only builds a value from the connection variables (a URL, a connection string) sets network to off and runs with no network, so it is never taken for a call. Programs installed with majhi_toolbox_install are on its PATH. You get only the reference secret:<name>, never the value. Pass task and item to answer a pending secret request (saved under its name, the asking agent is told), or name to save a new one. The script is shown to the owner in the room.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task of the secret request to answer" },
          item: { type: "string", description: "The id of the secret request to answer" },
          name: { type: "string", description: "Without a request: the lowercase id to save under" },
          script: { type: "string", description: "A short read-only shell script. Its output is the secret" },
          connections: {
            type: "array",
            items: { type: "string" },
            description: "Ids of this workspace's connections the script needs",
          },
          network: {
            type: "string",
            enum: ["on", "off"],
            description: "off: no network, for a script that only builds a value. Default on",
          },
        },
        required: ["script", "connections"],
      },
    },
    {
      name: CLIPBOARD_COPY_TOOL,
      command: undefined,
      risk: undefined,
      description:
        "The captain in its main chat or a workspace lane, and only when the owner asked for it in the conversation. Put a value on the owner's own clipboard on their computer, so they can paste it without it appearing in chat: the value of a saved secret (secret), or one line of a file in this workspace's projects (file and line, with part value to take what follows the = or : of a KEY=value line). The value is read by majhi and goes only to the clipboard: you never get it back, and it is not put in the room. Say what you copied by its name or its file and line, never by its value.",
      inputSchema: {
        type: "object",
        properties: {
          secret: { type: "string", description: "The name of a saved secret, like newrelic-acme" },
          file: {
            type: "string",
            description: "Without a secret: the absolute path of a file in a project of this workspace",
          },
          line: { type: "number", description: "With file: the 1-based line to copy" },
          part: {
            type: "string",
            enum: ["whole", "value"],
            description:
              "whole (default): the line. value: what follows the = or : of a KEY=value line, without quotes",
          },
          ownerAsked: {
            type: "boolean",
            description: "true only if the owner asked for this in the conversation",
          },
          reason: EXTRA_PROPERTIES.reason,
        },
        required: ["ownerAsked", "reason"],
      },
    },
    {
      name: WITHDRAW_SECRET_TOOL,
      command: undefined,
      risk: undefined,
      description:
        "The captain in its lane only. Withdraw a pending secret request of this workspace that is no longer needed (a duplicate of another, or saved another way). The asking agent is told why and looks for another way.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task of the secret request" },
          item: { type: "string", description: "The id of the secret request" },
          reason: { type: "string", description: "Why it is no longer needed, in one line" },
        },
        required: ["task", "item", "reason"],
      },
    },
  );
  return tools;
}

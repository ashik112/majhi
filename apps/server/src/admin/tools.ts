import { type CommandName, commands, type RiskClass } from "@majhi/shared";
import { z } from "zod";

/** Commands an agent must never call: they approve, answer or reach outside majhi for the owner. */
export const NOT_TOOLS: ReadonlySet<CommandName> = new Set<CommandName>([
  "room.approve",
  "room.secret",
  "policy.set",
  "room.permission",
  "room.choose",
  "room.send",
  "room.cancel",
  "room.fresh",
  "ssh.unlock",
  "boss.chat",
]);

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

function commandSchema(command: CommandName): AdminTool["inputSchema"] {
  const schema = z.toJSONSchema(commands[command].input, { io: "input", unrepresentable: "any" });
  const { $schema: _dropped, ...rest } = schema as Record<string, unknown>;
  const properties = (rest.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(rest.required) ? (rest.required as string[]) : [];
  return {
    ...rest,
    type: "object",
    properties: { ...properties, ...EXTRA_PROPERTIES },
    required: [...required, "ownerAsked", "reason"],
  };
}

/** One tool per command that makes sense for an agent, plus `majhi_request_secret`. */
export function adminTools(): AdminTool[] {
  const tools: AdminTool[] = (Object.keys(commands) as CommandName[])
    .filter((name) => !NOT_TOOLS.has(name))
    .map((command) => {
      const def = commands[command];
      return {
        name: toolName(command),
        command,
        risk: def.risk,
        description: `${def.summary}. Risk: ${def.risk}.`,
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
  return tools;
}

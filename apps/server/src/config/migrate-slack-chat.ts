import type { ConnectionConfig } from "@majhi/shared";
import { type ConfigSections, connectionScopes } from "./sections.ts";

/**
 * A Slack app saved before client chats was an `env` connection that gave an agent the bot token. Slack is now a
 * chat app like Telegram: a `chat` connection only majhi reads, one setup path. This moves what was saved, once.
 * The two token entries keep their `secret:` references: no value is read, copied or written here.
 */

export interface LegacySlack {
  org: string;
  id: string;
  connection: ConnectionConfig;
}

/** The `env` connections of any workspace (or global) that a Slack setup made. */
export function legacySlack(sections: Pick<ConfigSections, "orgs" | "connections">): LegacySlack[] {
  const found: LegacySlack[] = [];
  for (const [org, entry] of Object.entries(connectionScopes(sections))) {
    for (const [id, connection] of Object.entries(entry.connections ?? {})) {
      if (connection.type === "env" && connection.fields?.service === "slack")
        found.push({ org, id, connection });
    }
  }
  return found;
}

/** The same connection as a chat app account: same name, account and token references, no access level and no agent switches. */
export function asChat(connection: ConnectionConfig): ConnectionConfig {
  const account = connection.fields?.account;
  return {
    type: "chat",
    name: connection.name,
    description: "Slack app for this workspace's client chats. Only majhi reads it.",
    fields: { service: "slack", ...(account === undefined ? {} : { account }) },
    ...(connection.vars === undefined ? {} : { vars: connection.vars }),
  };
}

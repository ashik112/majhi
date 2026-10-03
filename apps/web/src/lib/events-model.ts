import { type EventTopic, type ServerEvent, ServerEventSchema } from "@majhi/shared";
import { queryKeys } from "./queries";

/** The query keys to refetch when a topic changes. Onboarding progress reads accounts, agents, orgs, projects, sign-ins and clones. */
export function topicQueryKeys(topic: EventTopic): readonly (readonly string[])[] {
  switch (topic) {
    case "config":
      return [queryKeys.config];
    case "orgs":
      return [queryKeys.orgs, queryKeys.connections, queryKeys.onboarding];
    case "accounts":
      return [queryKeys.accounts, queryKeys.accountModels, queryKeys.onboarding];
    case "agents":
      // A connection lists the agents that use it.
      return [queryKeys.agents, queryKeys.connections, queryKeys.skills, queryKeys.onboarding];
    case "projects":
      return [queryKeys.projects, queryKeys.onboarding];
    case "tasks":
      return [queryKeys.tasks];
    case "secrets":
      return [queryKeys.secrets];
    case "usage":
      return [queryKeys.usage];
    case "budgets":
      return [queryKeys.budgets];
    case "memory":
      return [queryKeys.memory];
    case "containers":
      return [queryKeys.containers];
    case "schedules":
      return [queryKeys.schedules];
    case "triggers":
      return [queryKeys.triggers];
    case "connections":
      return [queryKeys.connections];
    case "autonomy":
      return [queryKeys.autonomy];
    case "captain":
      return [queryKeys.captain];
    case "signins":
      return [queryKeys.signins, queryKeys.onboarding];
    case "clones":
      return [queryKeys.clones, queryKeys.onboarding];
  }
}

/** Every topic, for a refetch after the feed was down and events may have been missed. */
export const ALL_TOPICS: readonly EventTopic[] = [
  "config",
  "orgs",
  "accounts",
  "agents",
  "projects",
  "tasks",
  "secrets",
  "usage",
  "budgets",
  "memory",
  "containers",
  "schedules",
  "triggers",
  "connections",
  "autonomy",
  "captain",
  "signins",
  "clones",
];

/** Parses one WebSocket text frame. Anything that is not a known event is dropped. */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  if (typeof raw !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ServerEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/** Reconnect delay after `attempt` failed tries in a row (0 is the first retry): 0.5 s, 1 s, 2 s ... 10 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}

/** The feed URL for a page location, `ws` or `wss` to match the page. */
export function wsUrl(path: string, loc: { protocol: string; host: string }): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}`;
}

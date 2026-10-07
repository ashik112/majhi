import { type EventTopic, type ServerEvent, ServerEventSchema, seqGap } from "@majhi/shared";
import { opsKeys } from "./ops-queries";
import { queryKeys } from "./queries";

/** The query keys to refetch when a topic changes. Onboarding progress reads accounts, agents, orgs, projects, sign-ins and clones. */
export function topicQueryKeys(topic: EventTopic): readonly (readonly string[])[] {
  switch (topic) {
    case "config":
      return [queryKeys.config];
    case "orgs":
      return [queryKeys.orgs, queryKeys.connections, queryKeys.onboarding];
    case "accounts":
      return [queryKeys.accounts, queryKeys.accountModels, queryKeys.onboarding, queryKeys.decisions];
    case "agents":
      // A connection lists the agents that use it.
      return [queryKeys.agents, queryKeys.connections, queryKeys.skills, queryKeys.onboarding];
    case "skills":
      return [queryKeys.skills];
    case "projects":
      return [queryKeys.projects, queryKeys.onboarding];
    case "tasks":
      return [queryKeys.tasks, queryKeys.decisions, queryKeys.agenda, queryKeys.conversations];
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
      return [queryKeys.schedules, queryKeys.playbooks];
    case "triggers":
      return [queryKeys.triggers];
    case "connections":
      return [queryKeys.connections];
    case "autonomy":
      return [queryKeys.autonomy, queryKeys.decisions, queryKeys.agenda];
    case "captain":
      return [queryKeys.captain, queryKeys.decisions, queryKeys.agenda];
    case "agenda":
      return [queryKeys.agenda];
    case "findings":
      return [queryKeys.findings, queryKeys.decisions, queryKeys.agenda];
    case "playbooks":
      return [
        queryKeys.playbooks,
        queryKeys.findings,
        queryKeys.decisions,
        queryKeys.captain,
        queryKeys.agenda,
      ];
    case "ops":
      return [queryKeys.ops, queryKeys.decisions, queryKeys.findings];
    case "clients":
      return [queryKeys.clients, queryKeys.decisions, queryKeys.incident];
    case "signins":
      return [queryKeys.signins, queryKeys.onboarding];
    case "clones":
      return [queryKeys.clones, queryKeys.onboarding];
    case "checks":
      return [opsKeys.checks];
    case "wiki":
      return [queryKeys.wiki];
  }
}

/** What one event asks the board to read: query keys to refetch, and tasks to read by id. */
export interface EventPlan {
  /** Whole query groups to refetch (the lists the event may have changed). */
  keys: readonly (readonly string[])[];
  /** Tasks the server named: read just these, patch the task list, and recount. */
  tasks: readonly string[];
  /** The named tasks that changed in a way that may change what waits for the owner: their decisions are read again. */
  waits: readonly string[];
}

/**
 * What an event changes. A `tasks` event that names its tasks reads only those tasks. A change of
 * the row alone (`rows`: work starting or stopping, a message, a title) changes nothing else; any other change to a named task may change what waits for the
 * owner, so that task's decisions and the agenda are read again. An event that names no task reads the lists.
 */
export function planEvent(event: ServerEvent): EventPlan {
  const keys = new Map<string, readonly string[]>();
  const add = (list: readonly (readonly string[])[]) => {
    for (const key of list) keys.set(key.join("/"), key);
  };
  const tasks: string[] = [];
  const waits: string[] = [];
  // A conversation event is applied to the cached list as it is (see `patchConversation`): nothing to read.
  if (event.type === "hello" || event.type === "conversation") return { keys: [], tasks, waits };
  if (event.type === "attention") {
    // The item is new: the lists that count it must show it at once.
    add(topicQueryKeys("tasks"));
    return { keys: [...keys.values()], tasks, waits };
  }
  for (const topic of event.topics) {
    if (topic === "tasks" && event.tasks !== undefined) {
      tasks.push(...event.tasks);
      if (event.rows !== true) {
        waits.push(...event.tasks);
        add([queryKeys.agenda]);
      }
    } else add(topicQueryKeys(topic));
  }
  return { keys: [...keys.values()], tasks, waits };
}

/**
 * What a tab does with one frame of the feed: the number it saw, whether a frame was lost before it
 * (then everything is read again, once), and the plan for the event itself.
 */
export function feedStep(
  last: number | undefined,
  event: ServerEvent,
): { seq: number | undefined; full: boolean; plan: EventPlan } {
  const full = seqGap(last, event.seq);
  return { seq: event.seq ?? last, full, plan: planEvent(event) };
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
  "findings",
  "playbooks",
  "ops",
  "agenda",
  "signins",
  "clones",
  "checks",
  "wiki",
  "clients",
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

/**
 * Closes a socket without the browser's "closed before the connection is established" warning:
 * one still connecting closes as soon as it opens, and nothing it says then is handled.
 */
export function closeSocket(ws: WebSocket): void {
  ws.onmessage = null;
  ws.onerror = null;
  if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
  else ws.close();
}

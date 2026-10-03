import type { EventTopic, ServerEvent } from "@majhi/shared";
import { BrowserTabs } from "./tabs.ts";
import { OwnerTyping } from "./typing.ts";

type Listener = (event: ServerEvent) => void;

/** Fan-out of change events to every open `/api/events` socket. */
export class EventHub {
  private readonly listeners = new Set<Listener>();
  /** The open tabs that can pop browser notifications, as they report it. */
  readonly tabs = new BrowserTabs();
  /** The tasks the owner types in right now. */
  readonly typing = new OwnerTyping();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends one event, like an attention notice, to every open socket. */
  send(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  emit(topics: readonly EventTopic[]): void {
    const unique = [...new Set(topics)];
    const [first, ...rest] = unique;
    if (first === undefined) return;
    const event: ServerEvent = { type: "changed", topics: [first, ...rest] };
    for (const listener of this.listeners) listener(event);
  }
}

/** Topics a command changes. Reads change nothing. */
export function topicsFor(command: string): EventTopic[] {
  const group = command.split(".", 1)[0];
  switch (group) {
    case "orgs":
      return ["orgs", "config"];
    case "accounts":
      return ["accounts", "config"];
    case "agents":
      return ["agents"];
    case "boss":
      return ["agents", "config"];
    case "workspaces":
      return ["config"];
    case "projects":
      return ["projects", "config"];
    case "git":
      // OAuth apps are config and secrets; a sign-in ends by saving a token for an org.
      return ["signins", "orgs", "config", "secrets"];
    case "tasks":
      return ["tasks"];
    case "settings":
    case "policy":
      return ["config"];
    case "history":
      return ["config", "orgs", "accounts", "agents", "projects", "connections"];
    case "secrets":
      return ["secrets"];
    case "connections":
      // A change is a config commit, may save or delete secrets, and remove edits agent files.
      return ["connections", "config", "secrets", "agents"];
    case "trackers":
      // A pull or a push makes or links tasks; the org page shows the last pull.
      return ["tasks", "orgs"];
    case "usage":
      return ["usage", "config"];
    case "memory":
      return ["memory"];
    case "containers":
      return ["containers", "config"];
    case "schedules":
      return ["schedules"];
    case "triggers":
      return ["triggers"];
    case "autonomy":
      // Settings and instructions are config commits; the mode and the queue are autonomy's own.
      // The captain's choice per workspace is in the same settings.
      return ["autonomy", "captain", "config", "tasks"];
    case "captain":
      // The stop switch also stops autonomous mode; Undo reverts config, tasks or memory.
      return ["captain", "autonomy", "config", "tasks", "memory"];
    default:
      return [];
  }
}

import type { EventTopic, ServerEvent } from "@majhi/shared";

type Listener = (event: ServerEvent) => void;

/** Fan-out of change events to every open `/api/events` socket. */
export class EventHub {
  private readonly listeners = new Set<Listener>();

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
    default:
      return [];
  }
}

import type { EventTopic, ServerEvent } from "@majhi/shared";
import { BrowserTabs } from "./tabs.ts";
import { OwnerTyping } from "./typing.ts";

type Listener = (event: ServerEvent) => void;

/** An event names at most this many tasks (the schema allows 100). */
const MAX_NAMED = 100;

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

  /**
   * Tells every tab what changed. `scope.tasks` names the tasks that changed (the board reads just those);
   * `scope.rows` says only their list rows changed, nothing that waits for the owner. Without a scope, any task may have changed.
   */
  emit(topics: readonly EventTopic[], scope?: { tasks?: readonly string[]; rows?: true }): void {
    const unique = [...new Set(topics)];
    const [first, ...rest] = unique;
    if (first === undefined) return;
    const event: ServerEvent = { type: "changed", topics: [first, ...rest] };
    const named = scope?.tasks === undefined ? [] : [...new Set(scope.tasks)];
    // Too many to name: say nothing, and every tab reads the lists.
    if (named.length > 0 && named.length <= MAX_NAMED) {
      event.tasks = named;
      if (scope?.rows === true) event.rows = true;
    }
    for (const listener of this.listeners) listener(event);
  }

  /** One task changed. `rows`: only its list row (who works on it, a touch, a title), nothing that waits for the owner. */
  emitTask(task: string, rows?: true): void {
    this.emit(["tasks"], rows === true ? { tasks: [task], rows } : { tasks: [task] });
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
      // `boss.chat` only opens the captain chat. It must not emit: the page reads it under the agents key, so an
      // event refetched it, which emitted again, and one open tab kept the server and every page busy.
      return command === "boss.set" ? ["agents", "config"] : [];
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
    case "connect":
      // A connect attempt changes a connection and its grant; a finding may be filed.
      return ["connections", "config", "findings"];
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
    case "playbooks":
    case "goals":
    case "outbound":
      // A draft waits in Decisions; a playbook run files findings and shows in the captain's log.
      return ["playbooks", "findings", "captain"];
    case "ops":
      return ["ops", "findings", "playbooks"];
    case "findings":
      // A task made from a finding shows on the board too.
      return ["findings", "tasks"];
    case "notices":
      return ["notices"];
    case "chat":
    case "contacts":
      // A reply waits in Decisions too.
      return ["clients", "playbooks"];
    case "captain":
      // The stop switch also stops autonomous mode; Undo reverts config, tasks or memory.
      return ["captain", "autonomy", "config", "tasks", "memory"];
    default:
      return [];
  }
}

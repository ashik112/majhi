import { type Fact, type MemoryAction, type MemoryEvent, parseScope } from "@majhi/shared";

/** The Memory page's filters: every fact, global ones, facts of one org and its projects, and those waiting for the owner. */
export type ScopeFilter = "all" | "global" | "review" | `org:${string}`;

/** Which org each project belongs to, to put project facts under their org. */
export type ProjectOrgs = ReadonlyMap<string, string>;

export function inFilter(fact: Fact, filter: ScopeFilter, projectOrgs: ProjectOrgs): boolean {
  if (filter === "all") return true;
  if (filter === "review") return fact.status === "pending";
  if (filter === "global") return fact.scope === "global";
  const scope = parseScope(fact.scope);
  if (scope?.kind === "org") return `org:${scope.id}` === filter;
  if (scope?.kind === "project") return `org:${projectOrgs.get(scope.id) ?? ""}` === filter;
  return false;
}

/** "Global", "Acme" or "alpha-api": where a fact holds. */
export function scopeLabel(scope: string, orgNames: ReadonlyMap<string, string>): string {
  const parsed = parseScope(scope);
  if (parsed === undefined || parsed.kind === "global") return "Global";
  return parsed.kind === "org" ? (orgNames.get(parsed.id) ?? parsed.id) : parsed.id;
}

/** "Global", "Org Acme" or "Project alpha-api", for the badge on a fact. */
export function scopeText(scope: string, orgNames: ReadonlyMap<string, string>): string {
  const kind = scopeKind(scope);
  if (kind === "global") return "Global";
  return `${kind === "org" ? "Org" : "Project"} ${scopeLabel(scope, orgNames)}`;
}

export function scopeKind(scope: string): "global" | "org" | "project" {
  return parseScope(scope)?.kind ?? "global";
}

/** Facts to show on the page: the ones that hold or wait. Retired and rejected ones are in the log. */
export function shownFact(fact: Fact): boolean {
  return fact.status === "active" || fact.status === "pending";
}

/** A step curation took on its own, with a reason and how sure it was. */
export function isAutomatic(event: MemoryEvent): boolean {
  return event.actor === "curation";
}

const UNDOABLE: readonly MemoryAction[] = ["approved", "rejected", "retired", "duplicate"];

/** `memory.undo` accepts it: a step that changed a fact and was not undone yet. */
export function canUndo(event: MemoryEvent): boolean {
  return !event.undone && event.from !== undefined && UNDOABLE.includes(event.action);
}

/** What a logged step did, in a word. The owner's own steps read as the owner's. */
export function actionLabel(event: MemoryEvent): string {
  const auto = isAutomatic(event);
  switch (event.action) {
    case "proposed":
      return "Proposed";
    case "added":
      return "Added";
    case "approved":
      return auto ? "Kept" : "Approved";
    case "rejected":
      return auto ? "Dropped" : "Rejected";
    case "retired":
      return auto ? "Retired" : "Forgotten";
    case "duplicate":
      return event.from === undefined ? "Already known" : "Merged";
    case "restored":
      return "Undone";
    case "pinned":
      return "Pinned";
    case "unpinned":
      return "Unpinned";
    case "promoted":
      return "To AGENTS.md";
    case "unpromoted":
      return "Released";
  }
}

/** Who took the step, for the log line. */
export function actorLabel(event: MemoryEvent): string {
  if (event.actor === "curation")
    return event.provider === undefined ? "Automatic" : `Automatic, ${providerLabel(event.provider)}`;
  if (event.actor.startsWith("agent:")) return `@${event.actor.slice("agent:".length)}`;
  return event.actor === "owner" ? "You" : event.actor;
}

const PROVIDERS: Record<string, string> = { laya: "Laya", jev: "Jev", acp: "stand-in agent", rules: "rules" };
export function providerLabel(provider: string): string {
  return PROVIDERS[provider] ?? provider;
}

export function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

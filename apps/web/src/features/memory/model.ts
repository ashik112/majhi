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
  return `${kind === "org" ? "Workspace" : "Project"} ${scopeLabel(scope, orgNames)}`;
}

/** What a fact is, in two words: what the owner said, a debugging playbook, or a lesson an agent learned. */
export function kindLabel(fact: Pick<Fact, "kind" | "source">): string {
  if (fact.kind === "playbook") return "Debugging";
  if (fact.kind === "statement" || fact.source === "owner") return "Owner said";
  return "Lesson";
}

/** Every scope a fact can be moved to: global, each org, each project under its org. */
export function scopeOptions(
  orgNames: ReadonlyMap<string, string>,
  projectOrgs: ProjectOrgs,
): { scope: string; label: string }[] {
  const orgs = [...new Set([...orgNames.keys(), ...projectOrgs.values()])].sort();
  return [
    { scope: "global", label: "Global: applies everywhere" },
    ...orgs.flatMap((org) => [
      { scope: `org:${org}`, label: `Workspace ${orgNames.get(org) ?? org}` },
      ...[...projectOrgs]
        .filter(([, o]) => o === org)
        .map(([p]) => p)
        .sort()
        .map((p) => ({ scope: `project:${p}`, label: `Project ${p} (${orgNames.get(org) ?? org})` })),
    ]),
  ];
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
    case "edited":
      return "Edited";
  }
}

/** Who took the step, for the log line. */
export function actorLabel(event: MemoryEvent): string {
  if (event.actor === "curation")
    return event.provider === undefined ? "Automatic" : `Automatic, ${providerLabel(event.provider)}`;
  if (event.actor.startsWith("agent:")) return `@${event.actor.slice("agent:".length)}`;
  return event.actor === "owner" ? "You" : event.actor;
}

const PROVIDERS: Record<string, string> = {
  laya: "Laya",
  jev: "Jev",
  acp: "stand-in agent",
  rules: "rules",
  owner: "you said it",
};
export function providerLabel(provider: string): string {
  return PROVIDERS[provider] ?? provider;
}

export function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** The Memory list's row for lessons that hold everywhere. Not a project id: ids have no uppercase. */
export const GLOBAL = "Global";

export type MemoryTab = "brief" | "tasks" | "threads" | "lessons";
export const MEMORY_TABS: readonly MemoryTab[] = ["brief", "tasks", "threads", "lessons"];

/** What memory holds for one row of the list. */
export interface MemoryCounts {
  records: number;
  open: number;
  /** Lessons that wait for the owner. */
  waiting: number;
  /** Active lessons. */
  lessons: number;
}

const ZERO: MemoryCounts = { records: 0, open: 0, waiting: 0, lessons: 0 };

/** Which rows a fact belongs to: its project, every project of its org, or the Global row. */
export function factTargets(fact: Fact, projectOrgs: ProjectOrgs): string[] {
  const scope = parseScope(fact.scope);
  if (scope === undefined || scope.kind === "global") return [GLOBAL];
  if (scope.kind === "project") return [scope.id];
  return [...projectOrgs.entries()].filter(([, org]) => org === scope.id).map(([project]) => project);
}

/** The facts a row shows: a project's own and its org's, or the global ones. */
export function factsOf(target: string, facts: readonly Fact[], projectOrgs: ProjectOrgs): Fact[] {
  return facts.filter((f) => factTargets(f, projectOrgs).includes(target));
}

/**
 * Per row of the list: task records, open threads and lessons waiting for the owner. Records and
 * threads without a project count on the Global row.
 */
export function memoryCounts(
  records: readonly { projects: readonly string[] }[],
  threads: readonly { project?: string | undefined; status: string }[],
  facts: readonly Fact[],
  projectOrgs: ProjectOrgs,
): ReadonlyMap<string, MemoryCounts> {
  const out = new Map<string, MemoryCounts>();
  const bump = (key: string, field: keyof MemoryCounts) => {
    const now = out.get(key) ?? ZERO;
    out.set(key, { ...now, [field]: now[field] + 1 });
  };
  for (const r of records) {
    if (r.projects.length === 0) bump(GLOBAL, "records");
    for (const p of r.projects) bump(p, "records");
  }
  for (const t of threads) if (t.status === "open") bump(t.project ?? GLOBAL, "open");
  for (const f of facts) {
    const field = f.status === "pending" ? "waiting" : f.status === "active" ? "lessons" : undefined;
    if (field === undefined) continue;
    for (const target of factTargets(f, projectOrgs)) bump(target, field);
  }
  return out;
}

export function countsOf(counts: ReadonlyMap<string, MemoryCounts>, key: string): MemoryCounts {
  return counts.get(key) ?? ZERO;
}

/** Where "N to review" leads: the row of the first lesson that waits. */
export function reviewTarget(pending: readonly Fact[], projectOrgs: ProjectOrgs): string | undefined {
  for (const f of pending) {
    const target = factTargets(f, projectOrgs)[0];
    if (target !== undefined) return target;
  }
  return undefined;
}

/** A brief's `## ` sections in order. Text before the first heading, or a brief without any, is one untitled part. */
export function briefSections(body: string): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  let title = "";
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (title !== "" || text !== "") out.push({ title, text });
  };
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] === undefined) {
      lines.push(line);
      continue;
    }
    flush();
    title = heading[1];
    lines = [];
  }
  flush();
  return out;
}

/** A brief from before briefs were kept to short bullets: some section is prose. */
export function proseBrief(body: string): boolean {
  return briefSections(body).some((s) => !emptySection(s.text) && !/^\s*[-*]\s/m.test(s.text));
}

/** A section with nothing in it: empty, or the brief's "Nothing yet." */
export function emptySection(text: string): boolean {
  return /^(nothing yet\.?)?$/i.test(text.trim());
}

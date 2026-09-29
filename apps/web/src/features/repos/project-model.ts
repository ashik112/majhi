import { IdSchema, type ProjectView, type Repo } from "@majhi/shared";
import { repoMatches } from "./filter";

/** A project id from a folder name: `Globex API` becomes `globex-api`. Empty when nothing usable is left. */
export function suggestProjectId(folder: string, taken: readonly string[] = []): string {
  const base = folder
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (base === "") return "";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** The problem with a project id, or undefined when it is fine. */
export function projectIdError(id: string, taken: readonly string[]): string | undefined {
  if (id.trim() === "") return "Give the project an id";
  const parsed = IdSchema.safeParse(id);
  if (!parsed.success) return parsed.error.issues[0]?.message;
  if (taken.includes(id)) return "Another project already uses this id";
  return undefined;
}

/** Aliases that another project already uses. The server rejects them; this says so before sending. */
export function aliasClashes(
  aliases: readonly string[],
  projects: readonly ProjectView[],
  selfId: string,
): { alias: string; project: string }[] {
  const clashes: { alias: string; project: string }[] = [];
  for (const alias of aliases) {
    const other = projects.find((p) => p.id !== selfId && (p.aliases.includes(alias) || p.id === alias));
    if (other) clashes.push({ alias, project: other.id });
  }
  return clashes;
}

/** The registered project whose checkout is this path. */
export function projectForPath(projects: readonly ProjectView[], path: string): ProjectView | undefined {
  return projects.find((p) => p.path === path);
}

/** Whether a registered project matches the search: its id, aliases, org or repo fields. */
export function projectMatches(
  project: Pick<ProjectView, "id" | "aliases" | "org" | "path">,
  repo: Repo | undefined,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true;
  const own = [project.id, project.org, project.path, ...project.aliases].join("\n").toLowerCase();
  return terms.every((term) => own.includes(term)) || (repo !== undefined && repoMatches(repo, terms));
}

export interface OrgGroup<T> {
  org: string;
  items: T[];
}

/** Projects grouped by org, in the order of `orgIds`; orgs no project uses are left out, unknown orgs come last. */
export function groupByOrg<T extends { org: string }>(
  items: readonly T[],
  orgIds: readonly string[],
): OrgGroup<T>[] {
  const known = orgIds.filter((id) => items.some((i) => i.org === id));
  const strays = [...new Set(items.map((i) => i.org))].filter((id) => !orgIds.includes(id)).sort();
  return [...known, ...strays].map((org) => ({ org, items: items.filter((i) => i.org === org) }));
}

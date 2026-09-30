import {
  IdSchema,
  type MrHost,
  type ProjectLink,
  type ProjectView,
  type RemoteConfig,
  type Repo,
} from "@majhi/shared";
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

/** A repo shaped from a project whose path the scan did not find, so its detail has something to show. */
export function stubRepo(project: Pick<ProjectView, "id" | "path">): Repo {
  return { name: project.id, path: project.path, relPath: project.path, remotes: [], registered: true };
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

// Merge request remote and links (5.5) ----------------------------------------

/** What the owner picks in the project dialog for the remote merge requests go to. */
export interface MrRemoteChoice {
  /** The remote's name in git, like `origin`. */
  name: string;
  /** `""`: read the host from the remote's URL. */
  host: MrHost | "";
  /** A `Host` from ~/.ssh/config; `""` for none. */
  ssh: string;
}

/** The remote MRs go to and its saved host and alias, from the project's config. */
export function choiceFromProject(project: ProjectView | undefined): MrRemoteChoice {
  const name = project?.mrRemote ?? "origin";
  const saved = project?.remotes[name];
  return { name, host: saved?.host ?? "", ssh: saved?.ssh ?? "" };
}

/** Remote names to pick from: the ones git has, the ones the config names, and always `origin`. */
export function remoteNames(repo: Repo, project: ProjectView | undefined): string[] {
  return [...new Set(["origin", ...repo.remotes.map((r) => r.name), ...Object.keys(project?.remotes ?? {})])];
}

/**
 * The `remotes` value for `projects.update`/`register`: the saved remotes with the chosen one
 * marked. `undefined` leaves the config alone (nothing to say); `null` removes every remote entry.
 */
export function buildRemotes(
  existing: Readonly<Record<string, RemoteConfig>> | undefined,
  choice: MrRemoteChoice,
): Record<string, RemoteConfig> | null | undefined {
  const current = existing ?? {};
  const flagged = Object.entries(current).some(([, r]) => r.mr === true);
  const next: Record<string, RemoteConfig> = {};
  for (const [name, remote] of Object.entries(current)) {
    const { mr: _mr, ...rest } = remote;
    next[name] = rest;
  }
  const { mr: _cleared, ...kept } = next[choice.name] ?? {};
  const entry: RemoteConfig = { ...kept };
  if (choice.host === "") delete entry.host;
  else entry.host = choice.host;
  const ssh = choice.ssh.trim();
  if (ssh === "") delete entry.ssh;
  else entry.ssh = ssh;
  // `origin` is the default: it needs the flag only to take it back from another remote.
  if (choice.name !== "origin" || flagged) entry.mr = true;
  next[choice.name] = entry;
  for (const [name, remote] of Object.entries(next)) {
    if (Object.keys(remote).length === 0) delete next[name];
  }
  if (Object.keys(next).length === 0) return Object.keys(current).length === 0 ? undefined : null;
  return next;
}

/** `links` for the command: the chosen projects as `depends-on`. */
export function linksOf(dependsOn: readonly string[]): ProjectLink[] {
  return dependsOn.map((to) => ({ to, type: "depends-on" }));
}

import { IdSchema, type ProjectView } from "@majhi/shared";

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

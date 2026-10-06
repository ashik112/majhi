import { type WikiSystemLink, wikiPageId } from "@majhi/shared";
import type { WikiRepo } from "./repo.ts";
import type { WikiEnabled } from "./switch.ts";

/** The lines of TASK.md's "How this project works" section, at most. */
export const NOTE_LINES = 10;
/** At most this many of a task's projects get lines; the wiki tool has the rest. */
const NOTE_PROJECTS = 3;
const ROLES_SHOWN = 6;
const LINE_CHARS = 260;

const cut = (text: string, max = LINE_CHARS): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export interface WikiNotesDeps {
  repo: WikiRepo;
  enabled: WikiEnabled;
  /** The workspace's links, for the line on how the task's repos connect to others. Absent: no such line. */
  links?: ((org: string) => Promise<readonly WikiSystemLink[]>) | undefined;
}

/** Pairs of projects the links line names, at most. */
const PAIRS_SHOWN = 4;
const EXAMPLES = 2;

/**
 * One line on the links that touch the task's repos: who calls whom, how many links, how they are known, and a
 * couple of examples. Empty when none of the task's repos is on either side of a link.
 */
export function linksLine(projects: readonly string[], links: readonly WikiSystemLink[]): string | undefined {
  const mine = new Set(projects);
  const pairs = new Map<string, WikiSystemLink[]>();
  for (const l of links) {
    if (!mine.has(l.from.project) && !mine.has(l.to.project)) continue;
    const key = `${l.from.project}>${l.to.project}`;
    pairs.set(key, [...(pairs.get(key) ?? []), l]);
  }
  if (pairs.size === 0) return undefined;
  const shown = [...pairs.entries()]
    .toSorted((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, PAIRS_SHOWN)
    .map(([key, list]) => {
      const [from, to] = key.split(">");
      const basis = [...new Set(list.map((l) => l.basis))].join("/");
      const examples = list
        .slice(0, EXAMPLES)
        .map((l) => l.label)
        .join(", ");
      return `${from} calls ${to} (${list.length}, ${basis}: ${examples})`;
    });
  const more = pairs.size - shown.length;
  return cut(`Links to other projects: ${shown.join("; ")}${more > 0 ? `; ${more} more` : ""}.`);
}

/**
 * The short account of how a task's projects work, for TASK.md: per project the roles its overview found (where each
 * lives, in what) and the names of its flow pages, then one line on the `wiki` tool. Nothing when the workspace has
 * the wiki off, or none of the projects has an overview yet: the section is then left out.
 */
export function wikiNotes(deps: WikiNotesDeps) {
  return async (org: string | undefined, projects: readonly string[]): Promise<string[]> => {
    if (org === undefined || !(await deps.enabled(org))) return [];
    const lines: string[] = [];
    for (const project of projects.slice(0, NOTE_PROJECTS)) {
      const stored = deps.repo.page(org, project, wikiPageId({ kind: "overview" }))?.page;
      if (stored === undefined) continue;
      // The owner's decisions about roles show here too.
      const overview = deps.repo.shown(stored);
      const seen = new Set<string>();
      const roles = overview.roles
        .filter((r) => {
          const key = `${r.role}|${r.where}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, ROLES_SHOWN)
        .map((r) => `${r.role} ${r.tech} (${r.where})`);
      if (roles.length > 0) lines.push(cut(`${project}: ${roles.join("; ")}.`));
      const flows = deps.repo
        .pages(org, project)
        .filter((p) => p.kind === "flow")
        .map((p) => `${p.title} (${p.id})`);
      if (flows.length > 0) lines.push(cut(`${project} flows: ${flows.join("; ")}.`));
    }
    // The links the task's repos have with the workspace's other projects, even when none has an overview yet.
    const links = await deps.links?.(org).catch(() => []);
    const line = links === undefined ? undefined : linksLine(projects, links);
    if (line !== undefined) lines.push(line);
    if (lines.length === 0) return [];
    lines.push(
      "Details with file and line: the `wiki` tool of majhi-memory (list, read <page>, search <words>, sources <claim>).",
    );
    return lines.slice(0, NOTE_LINES);
  };
}

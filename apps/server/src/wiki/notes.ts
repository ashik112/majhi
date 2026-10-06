import { wikiPageId } from "@majhi/shared";
import type { WikiRepo } from "./repo.ts";
import type { WikiEnabled } from "./switch.ts";

/** The lines of TASK.md's "How this project works" section, at most. */
export const NOTE_LINES = 10;
/** At most this many of a task's projects get lines; the wiki tool has the rest. */
const NOTE_PROJECTS = 3;
const ROLES_SHOWN = 6;
const LINE_CHARS = 260;

const cut = (text: string): string => (text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text);

export interface WikiNotesDeps {
  repo: WikiRepo;
  enabled: WikiEnabled;
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
      const overview = deps.repo.page(org, project, wikiPageId({ kind: "overview" }))?.page;
      if (overview === undefined) continue;
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
    if (lines.length === 0) return [];
    lines.push(
      "Details with file and line: the `wiki` tool of majhi-memory (list, read <page>, search <words>, sources <claim>).",
    );
    return lines.slice(0, NOTE_LINES);
  };
}

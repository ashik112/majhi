import type { OrgView, ParsedTask, ProjectView, TaskSummary } from "@majhi/shared";
import { badgeLetters } from "../../lib/format";
import { inOrg, isOpen } from "../shell/model";

export interface ProjectGroup {
  org: string;
  name: string;
  badge: string;
  color: string | undefined;
  projects: ProjectView[];
}

/** Projects grouped by org, the filtered org first, then in the order the orgs are listed. Empty orgs are left out. */
export function groupProjects(
  projects: readonly ProjectView[],
  orgs: readonly OrgView[],
  firstOrg: string | undefined,
): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  for (const project of projects) {
    let group = groups.find((g) => g.org === project.org);
    if (!group) {
      const org = orgs.find((o) => o.id === project.org);
      group = {
        org: project.org,
        name: org?.name ?? project.org,
        badge: badgeLetters(org?.key ?? project.org),
        color: org?.color,
        projects: [],
      };
      groups.push(group);
    }
    group.projects.push(project);
  }
  const rank = (g: ProjectGroup) => {
    if (g.org === firstOrg) return -1;
    const at = orgs.findIndex((o) => o.id === g.org);
    return at === -1 ? orgs.length : at;
  };
  return groups.toSorted((a, b) => rank(a) - rank(b));
}

/** With an org filter on and one project in that org, the dialog opens with it chosen. */
export function initialProjects(projects: readonly ProjectView[], org: string | undefined): string[] {
  if (org === undefined) return [];
  const inOrg = projects.filter((p) => p.org === org);
  return inOrg.length === 1 && inOrg[0] ? [inOrg[0].id] : [];
}

export interface Draft {
  title: string;
  details: string;
}

/** What the task parser reads for the fields: title, then details. */
export function typedText({ title, details }: Draft): string {
  return [title.trim(), details.trim()].filter((part) => part !== "").join("\n\n");
}

/**
 * The `text` for `tasks.create`. The server reads repos and the base branch from the words, so a
 * project chosen with a chip that the words do not name goes in a closing `Repos:` line.
 */
export function composeTaskText(draft: Draft, picked: readonly string[], named: readonly string[]): string {
  const missing = picked.filter((id) => !named.includes(id));
  const text = typedText(draft);
  return missing.length === 0 ? text : `${text}\n\nRepos: ${missing.join(", ")}`;
}

/** The projects the words name (by id or alias), in order. */
export function namedProjects(parsed: ParsedTask | null): string[] {
  return parsed ? parsed.repos.map((r) => r.project) : [];
}

/** Chosen projects: what the words name plus what was clicked. Naming one in the words locks it on. */
export function chosenProjects(named: readonly string[], picked: readonly string[]): string[] {
  return [...new Set([...named, ...picked])];
}

/** Toggling a chip: clicking a project the words name changes nothing. */
export function togglePicked(picked: readonly string[], named: readonly string[], id: string): string[] {
  if (named.includes(id)) return [...picked];
  return picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
}

/** Whether the dialog can save: a title and no upload still running. */
export function canAdd(draft: Draft, uploading: boolean, saving: boolean): boolean {
  return draft.title.trim() !== "" && !uploading && !saving;
}

/** Open tasks a new task can depend on or belong to, filtered by the org filter, newest first. */
export function linkChoices(
  tasks: readonly TaskSummary[],
  org: string | undefined,
  exclude: readonly string[] = [],
): TaskSummary[] {
  return tasks
    .filter((t) => isOpen(t) && inOrg(t, org) && !exclude.includes(t.id))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** Adds the id to a multi-select, or removes it when it is there. */
export function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** What `tasks.create` gets for the links: nothing when none are chosen. */
export function linkFields(
  parent: string | undefined,
  dependsOn: readonly string[],
): { parent?: string; dependsOn?: string[] } {
  return {
    ...(parent === undefined ? {} : { parent }),
    ...(dependsOn.length === 0 ? {} : { dependsOn: [...dependsOn] }),
  };
}

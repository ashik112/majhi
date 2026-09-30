import type { ProjectView } from "@majhi/shared";
import { useEffect, useMemo, useState } from "react";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";

/** A value kept in this browser. Storage can be blocked or empty: then nothing is remembered. */
export function readStored(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}

/** Projects grouped under their org's name, orgs and projects in name order. */
export function projectGroups(
  projects: readonly ProjectView[],
  orgNames: ReadonlyMap<string, string>,
): { org: string; label: string; projects: ProjectView[] }[] {
  const groups = new Map<string, ProjectView[]>();
  for (const p of projects) groups.set(p.org, [...(groups.get(p.org) ?? []), p]);
  return [...groups.entries()]
    .map(([org, list]) => ({
      org,
      label: orgNames.get(org) ?? org,
      projects: list.toSorted((a, b) => a.id.localeCompare(b.id)),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

/**
 * The project a tab shows, remembered in this browser under `key`. Falls back to the first project
 * when the remembered one is gone. `allowAll` adds an "All projects" choice, the empty string.
 */
export function useChosenProject(
  key: string,
  projects: readonly ProjectView[] | undefined,
  allowAll: boolean,
): [string | undefined, (value: string) => void] {
  const [chosen, setChosen] = useState<string | undefined>(() => readStored(key));
  const ids = useMemo(() => new Set((projects ?? []).map((p) => p.id)), [projects]);
  useEffect(() => {
    if (projects === undefined) return;
    if (chosen === "" && allowAll) return;
    if (chosen !== undefined && ids.has(chosen)) return;
    setChosen(allowAll ? "" : projects[0]?.id);
  }, [projects, ids, chosen, allowAll]);
  const choose = (value: string) => {
    setChosen(value);
    writeStored(key, value);
  };
  return [chosen, choose];
}

/** A native select of projects, grouped by org. `""` is "All projects" when `allowAll` is set. */
export function ProjectPicker({
  projects,
  orgNames,
  value,
  onChange,
  allowAll = false,
  className,
}: {
  projects: readonly ProjectView[];
  orgNames: ReadonlyMap<string, string>;
  value: string | undefined;
  onChange: (value: string) => void;
  allowAll?: boolean;
  className?: string;
}) {
  const groups = projectGroups(projects, orgNames);
  return (
    <Select
      aria-label="Project"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className={cn("w-auto max-w-[320px] truncate", className)}
    >
      {allowAll && <option value="">All projects</option>}
      {groups.map((g) => (
        <optgroup key={g.org} label={g.label}>
          {g.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

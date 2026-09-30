import type { OrgView, ProjectView } from "@majhi/shared";
import { Globe } from "lucide-react";
import type { ReactNode } from "react";
import { Lamp } from "@/components/ui/lamp";
import { ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { orgLabel } from "@/features/accounts/model";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { countsOf, GLOBAL, type MemoryCounts } from "./model";

/** Where an org sits in the orgs' own order (Private first); unknown orgs last. */
function orgRank(org: string, orgs: readonly OrgView[]): number {
  const i = orgs.findIndex((o) => o.id === org);
  return i === -1 ? orgs.length : i;
}

/** Projects under their org, orgs in their own order, projects by id. */
function projectGroups(projects: readonly ProjectView[], orgs: readonly OrgView[]) {
  const groups = new Map<string, ProjectView[]>();
  for (const p of projects) groups.set(p.org, [...(groups.get(p.org) ?? []), p]);
  return [...groups.entries()]
    .map(([org, list]) => ({
      org,
      label: orgLabel(org, orgs),
      key: orgs.find((o) => o.id === org)?.key ?? org,
      projects: list.toSorted((a, b) => a.id.localeCompare(b.id)),
    }))
    .toSorted((a, b) => orgRank(a.org, orgs) - orgRank(b.org, orgs) || a.org.localeCompare(b.org));
}

/** The Global row first, then each org's projects, each row with what memory holds for it. */
export function MemoryList({
  projects,
  orgs,
  counts,
  selected,
  onSelect,
}: {
  projects: readonly ProjectView[] | undefined;
  orgs: readonly OrgView[];
  counts: ReadonlyMap<string, MemoryCounts>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  if (projects === undefined) return <RowsSkeleton rows={5} height={46} />;
  return (
    <div className="flex flex-col gap-3">
      <Group
        label="Global"
        badge={
          <span
            aria-hidden="true"
            className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-line-control bg-raised text-fg-soft"
          >
            <Globe className="size-3" strokeWidth={2.25} />
          </span>
        }
      >
        <Row
          name="Global lessons"
          mono={false}
          counts={countsOf(counts, GLOBAL)}
          global
          selected={selected === GLOBAL}
          onSelect={() => onSelect(GLOBAL)}
        />
      </Group>
      {projectGroups(projects, orgs).map((g) => (
        <Group
          key={g.org}
          label={g.label.name}
          count={g.projects.length}
          badge={<OrgBadge label={badgeLetters(g.key)} color={g.label.color} size="xs" />}
        >
          {g.projects.map((p) => (
            <Row
              key={p.id}
              name={p.id}
              counts={countsOf(counts, p.id)}
              selected={selected === p.id}
              onSelect={() => onSelect(p.id)}
            />
          ))}
        </Group>
      ))}
      {projects.length === 0 && (
        <p className="px-2 text-sm text-fg-faint text-pretty">
          No projects yet. A project gets a brief and records once it is registered and a task in it is done.
        </p>
      )}
    </div>
  );
}

function Group({
  label,
  count,
  badge,
  children,
}: {
  label: string;
  count?: number;
  badge: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-px">
      <div className="flex h-8 items-center gap-2 pl-2">
        {badge}
        <h2 className="min-w-0 truncate text-sm font-medium text-fg-soft">{label}</h2>
        {count !== undefined && <span className="tnum font-mono text-xs text-fg-faint">{count}</span>}
      </div>
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}

/**
 * A project's id, then its task records and open threads, and, lit, the lessons that wait for the
 * owner. The Global row counts its lessons, then records and threads only when it has any.
 */
function Row({
  name,
  counts,
  selected,
  onSelect,
  mono = true,
  global = false,
}: {
  name: string;
  counts: MemoryCounts;
  selected: boolean;
  onSelect: () => void;
  mono?: boolean;
  global?: boolean;
}) {
  const parts: { key: string; node: ReactNode }[] = [];
  if (global) parts.push({ key: "l", node: <Count n={counts.lessons} word="lesson" /> });
  if (!global || counts.records > 0) parts.push({ key: "r", node: <Count n={counts.records} word="task" /> });
  if (!global || counts.open > 0) parts.push({ key: "o", node: <Count n={counts.open} word="open" plain /> });
  if (counts.waiting > 0)
    parts.push({
      key: "w",
      node: (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-lamp-needs">
          <Lamp state="needs" size={6} />
          <span className="tnum font-mono">{counts.waiting}</span> to review
        </span>
      ),
    });
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          ROW,
          "min-h-[46px] flex-col justify-center gap-0.5 px-2.5 py-1.5",
          selected && ROW_SELECTED,
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate text-body font-medium",
            mono && "font-mono text-base",
            selected ? "text-fg" : "text-fg-soft",
          )}
        >
          {name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-faint">
          {parts.map((p, i) => (
            <span key={p.key} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden="true">·</span>}
              {p.node}
            </span>
          ))}
        </span>
      </button>
    </li>
  );
}

function Count({ n, word, plain = false }: { n: number; word: string; plain?: boolean }) {
  return (
    <span className="whitespace-nowrap">
      <span className={cn("tnum font-mono", n === 0 ? "text-fg-faint" : "text-fg-muted")}>{n}</span>{" "}
      {plain || n === 1 ? word : `${word}s`}
    </span>
  );
}

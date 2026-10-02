import { collapseHome, type Repo } from "@majhi/shared";
import { CircleCheck, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultOrgId } from "@/features/accounts/model";
import { suggestProjectId } from "@/features/repos/project-model";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useConfig, useRepos, useRescan } from "@/lib/queries";
import { useProjects, useRegisterProject } from "@/lib/task-queries";
import { Tick } from "../bits";
import { Problem, useStep } from "../step-frame";
import type { ProjectsWay } from "./projects-step";
import { WorkspaceSelect } from "./workspace-select";

/** Repos the scan found under the project folders: tick the ones to add, pick their workspace, add. */
export function LocalRepos({ onWay }: { onWay: (way: ProjectsWay) => void }) {
  const step = useStep();
  const repos = useRepos(true);
  const rescan = useRescan();
  const projects = useProjects();
  const register = useRegisterProject();
  const home = useConfig().data?.home ?? "";
  const workspaces = step.status.workspaces;
  const [orgPick, setOrg] = useState<string>();
  const org = orgPick ?? defaultOrgId(workspaces);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);

  const all = useMemo(() => {
    const list = (repos.data?.roots ?? []).flatMap((r) => r.repos);
    return [...list].sort(
      (a, b) => Number(a.registered) - Number(b.registered) || a.name.localeCompare(b.name),
    );
  }, [repos.data]);

  async function add() {
    setBusy(true);
    const taken = (projects.data ?? []).map((p) => p.id);
    const problems = new Map<string, string>();
    for (const repo of all.filter((r) => ticked.has(r.path))) {
      const id = suggestProjectId(repo.name, taken);
      taken.push(id);
      try {
        await register.mutateAsync({ id, org, path: repo.path, aliases: [] });
      } catch (error) {
        problems.set(repo.path, describeError(error));
      }
    }
    setFailures(problems);
    setTicked(new Set([...problems.keys()]));
    setBusy(false);
  }

  if (repos.isPending) return <RowsLoading />;
  if (repos.isError)
    return <Problem>The scan of your project folders failed: {describeError(repos.error)}</Problem>;
  if (all.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-control px-5 py-6">
        <p className="m-0 text-body text-fg-soft">No git repos in your project folder yet.</p>
        <p className="m-0 text-base text-fg-muted">Clone one from a git host, or start a new project.</p>
        <div className="flex gap-2 pt-1">
          <Button onClick={() => onWay("remote")}>From a git host</Button>
          <Button variant="ghost" onClick={() => onWay("new")}>
            New project
          </Button>
        </div>
      </div>
    );
  }

  const count = ticked.size;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-base text-fg-muted">Add to</span>
        <WorkspaceSelect workspaces={workspaces} value={org} onChange={setOrg} className="h-10 w-[180px]" />
        <Button
          variant={step.done || count === 0 ? "secondary" : "primary"}
          size="lg"
          disabled={count === 0 || busy}
          onClick={() => void add()}
        >
          {busy ? "Adding" : count === 0 ? "Tick repos to add" : `Add ${plural(count, "project")}`}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={rescan.isPending}
          onClick={() => rescan.mutate()}
        >
          <RefreshCw aria-hidden="true" className={rescan.isPending ? "animate-spin" : undefined} />
          {rescan.isPending ? "Looking" : "Look again"}
        </Button>
      </div>
      <ul aria-label="Repos on this computer" className="m-0 flex list-none flex-col gap-1.5 p-0">
        {all.map((repo) => (
          <RepoRow
            key={repo.path}
            repo={repo}
            home={home}
            ticked={ticked.has(repo.path)}
            failure={failures.get(repo.path)}
            disabled={busy}
            onTick={(on) => {
              const next = new Set(ticked);
              if (on) next.add(repo.path);
              else next.delete(repo.path);
              setTicked(next);
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function RepoRow({
  repo,
  home,
  ticked,
  failure,
  disabled,
  onTick,
}: {
  repo: Repo;
  home: string;
  ticked: boolean;
  failure: string | undefined;
  disabled: boolean;
  onTick: (on: boolean) => void;
}) {
  const host = repo.remotes[0]?.host;
  return (
    <li
      className={cn(
        "flex min-h-[52px] items-center gap-3 rounded-lg border px-3.5 py-2 transition-colors duration-150",
        ticked ? "border-accent-line bg-accent-wash" : "border-line-strong bg-card",
      )}
    >
      {repo.registered ? (
        <CircleCheck aria-hidden="true" className="size-[18px] shrink-0 text-green" />
      ) : (
        <Tick checked={ticked} disabled={disabled} label={`Add ${repo.name}`} onChange={onTick} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-base text-fg">{repo.name}</span>
        <span className="truncate font-mono text-xs text-fg-faint" title={repo.path}>
          {collapseHome(repo.path, home)}
        </span>
        {failure && <span className="text-sm text-red">{failure}</span>}
      </div>
      {host && host !== "other" && <HostGlyph host={host} className="size-4" />}
      {repo.branch && <span className="font-mono text-xs text-fg-faint">{repo.branch}</span>}
      {repo.registered && <span className="text-sm text-green">Added</span>}
    </li>
  );
}

export function RowsLoading() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-1.5">
      <span className="sr-only">Loading</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-[52px] items-center gap-3 rounded-lg border border-line px-3.5">
          <Skeleton className="size-[18px] rounded-[5px]" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-48" />
          </div>
        </div>
      ))}
    </div>
  );
}

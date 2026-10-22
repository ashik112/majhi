import { collapseHome, type Repo } from "@majhi/shared";
import { useEffect, useMemo, useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultOrgId } from "@/features/accounts/model";
import { suggestProjectId } from "@/features/repos/project-model";
import { EditRootsDialog } from "@/features/roots/edit-roots-dialog";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useConfig, useRepos } from "@/lib/queries";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects, useRegisterProject } from "@/lib/task-queries";
import { Tick } from "./bits";
import { Problem } from "./step-frame";

/** Where the repos were found, for the line under the heading: "Found 3 git repos in ~/Work". */
export function foundLine(count: number, roots: readonly string[], home: string): string {
  const where = roots.map((r) => collapseHome(r, home)).join(", ");
  return count === 0 ? `No git repos in ${where}.` : `Found ${plural(count, "git repo")} in ${where}.`;
}

/**
 * The git repos majhi found in the project folders, each with a checkbox, and "Add N projects". Every repo that
 * is not a project yet starts ticked: the owner unticks what agents must not touch. "Add another folder" opens the
 * folder picker.
 */
export function ProjectsPicker({
  org,
  onAdded,
  note,
}: {
  /** The workspace the projects join. Default: the owner's only workspace besides Private, else Private. */
  org?: string | undefined;
  /** The ids of the projects that were added (none when everything was added already). */
  onAdded: (projects: string[]) => void;
  /** The line under the repos, like where they were found. */
  note?: ((found: string) => void) | undefined;
}) {
  const repos = useRepos(true);
  const projects = useProjects();
  const register = useRegisterProject();
  const orgs = useOrgs().data ?? [];
  const home = useConfig().data?.home ?? "";
  const workspace = org ?? defaultOrgId(orgs);
  const [ticked, setTicked] = useState<ReadonlySet<string>>();
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const roots = repos.data?.roots ?? [];
  const all = useMemo(
    () =>
      roots
        .flatMap((r) => r.repos)
        .toSorted((a, b) => Number(a.registered) - Number(b.registered) || a.name.localeCompare(b.name)),
    [roots],
  );
  const fresh = all.filter((r) => !r.registered);
  // Every repo that is not a project yet starts ticked, once the scan is read.
  useEffect(() => {
    if (ticked === undefined && repos.data !== undefined) setTicked(new Set(fresh.map((r) => r.path)));
  }, [ticked, repos.data, fresh]);
  const rootPaths = roots.map((r) => r.path);
  const sentence = foundLine(all.length, rootPaths, home);
  useEffect(() => {
    if (repos.data !== undefined) note?.(sentence);
  }, [repos.data, sentence, note]);

  const picked = ticked ?? new Set<string>();

  async function add() {
    setBusy(true);
    const taken = (projects.data ?? []).map((p) => p.id);
    const problems = new Map<string, string>();
    const added: string[] = [];
    for (const repo of fresh.filter((r) => picked.has(r.path))) {
      const id = suggestProjectId(repo.name, taken);
      taken.push(id);
      try {
        await register.mutateAsync({ id, org: workspace, path: repo.path, aliases: [] });
        added.push(id);
      } catch (error) {
        problems.set(repo.path, describeError(error));
      }
    }
    setFailures(problems);
    setTicked(new Set([...problems.keys()]));
    setBusy(false);
    if (problems.size === 0) onAdded(added);
  }

  if (repos.isPending) return <RowsLoading />;
  if (repos.isError)
    return <Problem>The scan of your project folders failed: {describeError(repos.error)}</Problem>;
  const count = picked.size;
  return (
    <div className="flex flex-col gap-4">
      {all.length === 0 ? (
        <p className="m-0 rounded-xl border border-dashed border-line-control px-5 py-6 text-base text-fg-muted">
          {sentence} Add the folder that holds your repos.
        </p>
      ) : (
        <ul aria-label="Repos on this computer" className="m-0 flex list-none flex-col gap-2 p-0">
          {all.map((repo) => (
            <RepoRow
              key={repo.path}
              repo={repo}
              ticked={picked.has(repo.path)}
              failure={failures.get(repo.path)}
              disabled={busy}
              onTick={(on) => {
                const next = new Set(picked);
                if (on) next.add(repo.path);
                else next.delete(repo.path);
                setTicked(next);
              }}
            />
          ))}
        </ul>
      )}
      <p className="m-0 text-sm text-fg-muted">
        Repos somewhere else?{" "}
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="cursor-pointer text-fg-muted underline underline-offset-2 hover:text-fg"
        >
          Add another folder
        </button>
      </p>
      <div className="flex items-center gap-3">
        {fresh.length > 0 ? (
          <Button variant="primary" size="lg" disabled={count === 0 || busy} onClick={() => void add()}>
            {busy ? "Adding" : count === 0 ? "Tick repos to add" : `Add ${plural(count, "project")}`}
          </Button>
        ) : (
          all.length > 0 && (
            <Button variant="primary" size="lg" onClick={() => onAdded([])}>
              Continue
            </Button>
          )
        )}
      </div>
      {adding && <EditRootsDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function RepoRow({
  repo,
  ticked,
  failure,
  disabled,
  onTick,
}: {
  repo: Repo;
  ticked: boolean;
  failure: string | undefined;
  disabled: boolean;
  onTick: (on: boolean) => void;
}) {
  const host = repo.remotes[0]?.host;
  return (
    <li
      className={cn(
        "flex min-h-[46px] items-center gap-3 rounded-lg border px-3.5 py-2",
        "border-line-strong bg-card",
      )}
    >
      {repo.registered ? (
        <span className="size-[18px] shrink-0 text-center text-green" aria-hidden="true">
          ✓
        </span>
      ) : (
        <Tick checked={ticked} disabled={disabled} label={`Add ${repo.name}`} onChange={onTick} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-base text-fg">{repo.name}</span>
        {failure && <span className="text-sm text-red">{failure}</span>}
      </div>
      {repo.registered && <span className="text-sm text-green">Added</span>}
      {host && host !== "other" && (
        <span className="flex items-center gap-1.5 text-sm text-fg-muted">
          <HostGlyph host={host} className="size-3.5" />
          {HOST_NAME[host] ?? host}
        </span>
      )}
    </li>
  );
}

const HOST_NAME: Record<string, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket" };

function RowsLoading() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2">
      <span className="sr-only">Loading</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-[46px] items-center gap-3 rounded-lg border border-line px-3.5">
          <Skeleton className="size-[18px] rounded-[5px]" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

/** Step 2 as a dialog: Home's "Add a project" opens it when majhi has no project yet. */
export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const [found, setFound] = useState("");
  return (
    <Modal label="Add a project" onClose={onClose} className="w-[min(560px,calc(100vw-32px))]">
      <div className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-5">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-lg font-semibold text-fg">Pick your projects</h2>
          <p className="m-0 text-base text-fg-muted">{found} Agents work only in the projects you pick.</p>
        </div>
        <ProjectsPicker onAdded={onClose} note={setFound} />
      </div>
    </Modal>
  );
}

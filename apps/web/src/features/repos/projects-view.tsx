import {
  collapseHome,
  type ProjectView,
  RESTART_COMMAND,
  type Repo,
  type ReposResponse,
  type RootScan,
} from "@majhi/shared";
import { CircleAlert, FolderCog, FolderSync, FolderX, RefreshCw, Search, SearchX, X } from "lucide-react";
import { type KeyboardEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { InlineCommand } from "@/components/command-line";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { orgLabel } from "@/features/accounts/model";
import { ServerError } from "@/features/home/server-error";
import { EditRootsDialog } from "@/features/roots/edit-roots-dialog";
import { useMountNow } from "@/features/roots/use-mount-now";
import { cn } from "@/lib/cn";
import { badgeLetters, formatAgo, formatDuration, plural } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useConfig, useRepos, useRescan } from "@/lib/queries";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects, useRemoveProject } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { filterRoots, searchTerms } from "./filter";
import { groupByOrg, projectForPath, projectMatches } from "./project-model";
import { PROJECT_COLUMNS, ProjectRow, RepoRow } from "./project-row";
import { RegisterDialog } from "./register-dialog";
import { SshNotice } from "./ssh-notice";

const SUBTITLE = "Register a repo to use it in tasks. Aliases are the short names you type in the task box.";

/** Projects and links: the registered projects by org, then the repos majhi found that are not registered yet. */
export function ProjectsView() {
  const config = useConfig();
  const state = config.data;
  if (state && state.status === "loaded") return <Loaded home={state.home} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Projects and links" subtitle={SUBTITLE} />
      {config.isError ? (
        <ServerError
          error={config.error}
          onRetry={() => void config.refetch()}
          retrying={config.isFetching}
        />
      ) : (
        <div className="px-8 py-5">
          <RowsSkeleton rows={4} height={64} />
        </div>
      )}
    </div>
  );
}

function Loaded({ home }: { home: string }) {
  const repos = useRepos(true);
  const mount = useMountNow(home);
  const rescan = useRescan();
  const toast = useToast();
  const now = useNow(30_000);
  const projects = useProjects();
  const orgs = useOrgs();
  const removeProject = useRemoveProject();
  const { org: orgFilter } = useOrgFilter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const terms = useMemo(() => searchTerms(deferred), [deferred]);
  const [registering, setRegistering] = useState<{ repo: Repo; project?: ProjectView } | null>(null);
  const [removing, setRemoving] = useState<ProjectView | null>(null);
  const [removeError, setRemoveError] = useState<string>();
  const [editingRoots, setEditingRoots] = useState(false);

  const data: ReposResponse | undefined = repos.data;
  const roots = useMemo(
    () =>
      (data?.roots ?? []).map((root) => ({
        ...root,
        repos: root.repos.toSorted((a, b) => a.relPath.localeCompare(b.relPath)),
      })),
    [data],
  );
  const allRepos = useMemo(() => roots.flatMap((r) => r.repos), [roots]);
  const projectList = projects.data ?? [];
  const searching = terms.length > 0;

  const visibleProjects = projectList
    .filter((p) => orgFilter === undefined || p.org === orgFilter)
    .filter((p) =>
      projectMatches(
        p,
        allRepos.find((r) => r.path === p.path),
        terms,
      ),
    );
  const groups = groupByOrg(
    visibleProjects,
    (orgs.data ?? []).map((o) => o.id),
  );
  const unregistered = filterRoots(
    roots.map((root) => ({
      ...root,
      repos: root.repos.filter((r) => projectForPath(projectList, r.path) === undefined),
    })),
    terms,
  ).filter((root) => root.repos.length > 0);
  const unregisteredCount = unregistered.reduce((n, r) => n + r.repos.length, 0);
  const problemRoots = roots.filter((r) => !r.mounted || r.error);

  function runRescan() {
    if (rescan.isPending) return;
    rescan.mutate(undefined, {
      onSuccess: (result) => {
        const found = result.roots.reduce((sum, root) => sum + root.repos.length, 0);
        toast("Rescanned", { detail: `${plural(found, "repo")} in ${formatDuration(result.durationMs)}` });
      },
      onError: (error) => toast("Rescan failed", { detail: error.message, tone: "error" }),
    });
  }

  // "/" searches and "r" rescans, when no field has focus.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === "r") runRescan();
      else if (event.key === "Escape" && query !== "") setQuery("");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (query !== "") setQuery("");
    else event.currentTarget.blur();
  }

  const scanning = rescan.isPending;
  const totalRepos = allRepos.length;
  const notRegistered = allRepos.filter((r) => projectForPath(projectList, r.path) === undefined).length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Projects and links"
        subtitle={
          data ? (
            <>
              {plural(projectList.length, "project")}, {plural(notRegistered, "repo")} not registered. Scanned{" "}
              <time dateTime={data.scannedAt} title={new Date(data.scannedAt).toLocaleString()}>
                {formatAgo(data.scannedAt, now)}
              </time>
              {` in ${formatDuration(data.durationMs)}.`}
            </>
          ) : (
            SUBTITLE
          )
        }
      >
        <div className="relative w-64">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-faint"
          />
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search projects and repos"
            aria-label="Search repos"
            aria-keyshortcuts="/"
            className="peer h-10 pr-9 pl-8 [&::-webkit-search-cancel-button]:hidden"
          />
          {query === "" ? (
            <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 peer-focus-visible:opacity-0">
              /
            </Kbd>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear search"
              title="Clear search (Esc)"
              className="absolute top-1/2 right-1 size-6 -translate-y-1/2"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
        <Button size="lg" onClick={runRescan} disabled={scanning} aria-keyshortcuts="r">
          <RefreshCw aria-hidden="true" className={cn(scanning && "animate-spin")} />
          {scanning ? "Scanning" : "Rescan"}
        </Button>
        <Button size="lg" onClick={() => setEditingRoots(true)}>
          <FolderCog aria-hidden="true" />
          Edit roots
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-auto">
        <SshNotice className="mx-8 mt-5" />
        <div
          aria-busy={scanning}
          className={cn("flex flex-col gap-6 px-8 pt-5 pb-8 transition-opacity", scanning && "opacity-70")}
        >
          {repos.isError && !data ? (
            <ServerError
              error={repos.error}
              onRetry={() => void repos.refetch()}
              retrying={repos.isFetching}
            />
          ) : !data || projects.isPending ? (
            <RowsSkeleton rows={5} height={64} />
          ) : (
            <div className="flex flex-col gap-6">
              {(searching ? [] : problemRoots).map((root) => (
                <RootProblem
                  key={root.path}
                  root={root}
                  home={home}
                  onMount={mount.canMount ? mount.mountNow : undefined}
                  mounting={mount.pending}
                />
              ))}

              {projectList.length === 0 && !searching && (
                <p className="rounded-xl border border-dashed border-line-hover px-5 py-4 text-base text-fg-muted">
                  No projects yet. Register a repo below to use it in tasks.
                </p>
              )}

              {visibleProjects.length > 0 && (
                <section aria-label="Registered projects" className="flex flex-col gap-6">
                  <ColumnHeads />
                  {groups.map((group) => {
                    const org = orgLabel(group.org, orgs.data ?? []);
                    const key = orgs.data?.find((o) => o.id === group.org)?.key ?? group.org;
                    return (
                      <section key={group.org} aria-label={org.name} className="flex flex-col gap-2">
                        <h2 className="flex items-center gap-2 text-base font-semibold">
                          <OrgBadge label={badgeLetters(key)} color={org.color} size="sm" />
                          {org.name}
                          <span className="font-mono text-xs font-normal text-fg-faint tabular-nums">
                            {group.items.length}
                          </span>
                        </h2>
                        <ul className="flex flex-col gap-2">
                          {group.items.map((project) => {
                            const repo = allRepos.find((r) => r.path === project.path);
                            return (
                              <ProjectRow
                                key={project.id}
                                project={project}
                                repo={repo}
                                home={home}
                                terms={terms}
                                onEdit={() => setRegistering({ repo: repo ?? stubRepo(project), project })}
                                onRemove={() => {
                                  setRemoveError(undefined);
                                  setRemoving(project);
                                }}
                              />
                            );
                          })}
                        </ul>
                      </section>
                    );
                  })}
                </section>
              )}

              {searching && visibleProjects.length === 0 && unregisteredCount === 0 && (
                <NoMatches query={deferred.trim()} onClear={() => setQuery("")} />
              )}

              {unregisteredCount > 0 && (
                <section aria-label="Not registered" className="flex flex-col gap-4">
                  <div className="flex items-baseline gap-2.5">
                    <h2 className="text-md font-semibold">Not registered</h2>
                    <span className="text-sm text-fg-muted">
                      {plural(unregisteredCount, "repo")} in your workspace roots
                    </span>
                  </div>
                  {unregistered.map((root) => (
                    <RootList
                      key={root.path}
                      root={root}
                      home={home}
                      terms={terms}
                      onRegister={(repo) => setRegistering({ repo })}
                    />
                  ))}
                </section>
              )}

              {totalRepos === 0 && problemRoots.length === 0 && (
                <p className="text-base text-fg-muted text-pretty">
                  majhi found no git repos in{" "}
                  <span className="font-mono text-fg-soft">
                    {roots.map((r) => collapseHome(r.path, home)).join(", ")}
                  </span>
                  . It looks 4 levels deep and skips hidden folders and node_modules.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {registering && (
        <RegisterDialog
          repo={registering.repo}
          project={registering.project}
          onClose={() => setRegistering(null)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove project ${removing.id}`}
          body="majhi forgets this project and its aliases. The repo on disk is not touched. Existing tasks keep their worktrees."
          confirmLabel="Remove project"
          busy={removeProject.isPending}
          error={removeError}
          onCancel={() => setRemoving(null)}
          onConfirm={() =>
            removeProject.mutate(removing.id, {
              onSuccess: () => {
                toast("Project removed", { detail: removing.id });
                setRemoving(null);
              },
              onError: (error) => setRemoveError(error.message),
            })
          }
        />
      )}
      {editingRoots && <EditRootsDialog onClose={() => setEditingRoots(false)} />}
      {mount.modal}
    </div>
  );
}

/** A repo shaped from a project whose path the scan did not find, so the edit dialog has something to show. */
function stubRepo(project: ProjectView): Repo {
  return { name: project.id, path: project.path, relPath: project.path, remotes: [], registered: true };
}

function ColumnHeads() {
  return (
    <div
      className={cn("grid gap-4 px-4 text-xs tracking-[0.08em] text-fg-faint uppercase", PROJECT_COLUMNS)}
      aria-hidden="true"
    >
      <span>Project</span>
      <span>Remotes</span>
      <span>Local path</span>
      <span>Aliases and base</span>
      <span />
    </div>
  );
}

function RootList({
  root,
  home,
  terms,
  onRegister,
}: {
  root: RootScan;
  home: string;
  terms: readonly string[];
  onRegister: (repo: Repo) => void;
}) {
  const label = collapseHome(root.path, home);
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h3 className="font-mono text-sm text-fg-muted" title={root.path}>
        {label}
      </h3>
      <ul className="flex flex-col gap-2">
        {root.repos.map((repo) => (
          <RepoRow
            key={repo.path}
            repo={repo}
            home={home}
            terms={terms}
            onRegister={() => onRegister(repo)}
          />
        ))}
      </ul>
    </section>
  );
}

function RootProblem({
  root,
  home,
  onMount,
  mounting,
}: {
  root: RootScan;
  home: string;
  onMount: (() => void) | undefined;
  mounting: boolean;
}) {
  const label = collapseHome(root.path, home);
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-2 rounded-xl border border-amber-line bg-amber-wash px-4 py-3"
    >
      <div className="flex items-center gap-2.5">
        <FolderX aria-hidden="true" className="size-4 text-amber" />
        <h2 className="font-mono text-sm font-medium">{label}</h2>
        {!root.mounted && <Badge tone="amber">not mounted</Badge>}
        {root.error && <Badge tone="red">scan failed</Badge>}
      </div>
      {!root.mounted &&
        (onMount ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="text-base text-fg-muted">
              majhi cannot see this folder yet. Mounting it restarts majhi for a few seconds.
            </p>
            <Button size="sm" onClick={onMount} disabled={mounting}>
              <FolderSync aria-hidden="true" />
              {mounting ? "Mounting" : "Mount now"}
            </Button>
          </div>
        ) : (
          <p className="text-base leading-7 text-fg-muted">
            majhi cannot see this folder yet. Roots are mounted when majhi starts. Run{" "}
            <InlineCommand command={RESTART_COMMAND} /> on your machine, then rescan.
          </p>
        ))}
      {root.error && (
        <p className="flex items-start gap-2 font-mono text-sm text-red">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{root.error}</span>
        </p>
      )}
    </section>
  );
}

function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex max-w-[460px] flex-col gap-3 pt-6">
      <h2 className="flex items-center gap-2 text-md font-semibold">
        <SearchX aria-hidden="true" className="size-4 text-fg-faint" />
        No repos match <span className="font-mono">“{query}”</span>
      </h2>
      <p className="text-base text-fg-muted">
        Search checks names, aliases, paths, branches, remote URLs, hosts and SSH aliases.
      </p>
      <div>
        <Button onClick={onClear}>
          Clear search
          <Kbd className="ml-0.5">Esc</Kbd>
        </Button>
      </div>
    </div>
  );
}

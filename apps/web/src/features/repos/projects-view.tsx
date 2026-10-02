import {
  collapseHome,
  type ProjectView,
  RESTART_COMMAND,
  type Repo,
  type ReposResponse,
  type RootScan,
} from "@majhi/shared";
import {
  CircleAlert,
  FolderCog,
  FolderPlus,
  FolderSync,
  FolderX,
  RefreshCw,
  Search,
  SearchX,
  X,
} from "lucide-react";
import { type KeyboardEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { InlineCommand } from "@/components/command-line";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { DetailPane, DetailSection, ListDetail, ListPane, ROW_SELECTED } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton, Skeleton } from "@/components/ui/skeleton";
import { Dot } from "@/components/ui/status-dot";
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
import { useSearchParam } from "@/pages/parts/url-state";
import { filterRoots, searchTerms } from "./filter";
import { ProjectDetail } from "./project-detail";
import { groupByOrg, projectForPath, projectMatches } from "./project-model";
import { ProjectListRow, RepoRow } from "./project-row";
import { RegisterDialog } from "./register-dialog";
import { SshNotice } from "./ssh-notice";

const SUBTITLE = "Register a repo to use it in tasks. Aliases are the short names you type in the task box.";

/** What the detail side shows: a project, or the repos in the workspace roots that are not projects yet. */
type View = { kind: "project"; id: string } | { kind: "scan" };

/** Projects and links: registered projects by org on the left; the picked project, or the scan, on the right. */
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
  // A link from elsewhere (Ship's "Fix it in Projects") opens on its project.
  const [linked] = useSearchParam("project");
  const [view, setView] = useState<View | undefined>(linked ? { kind: "project", id: linked } : undefined);
  const [registering, setRegistering] = useState<Repo | null>(null);
  const [removing, setRemoving] = useState<ProjectView | null>(null);
  const [removeError, setRemoveError] = useState<string>();

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
  const orgList = orgs.data ?? [];
  const repoOf = (p: ProjectView) => allRepos.find((r) => r.path === p.path);

  const visibleProjects = projectList
    .filter((p) => orgFilter === undefined || p.org === orgFilter)
    .filter((p) => projectMatches(p, repoOf(p), terms));
  const groups = groupByOrg(
    visibleProjects,
    orgList.map((o) => o.id),
  );
  const notRegistered = allRepos.filter((r) => projectForPath(projectList, r.path) === undefined).length;
  const problemRoots = roots.filter((r) => !r.mounted || r.error);

  const firstVisible = groups[0]?.items[0];
  const picked = view?.kind === "project" ? projectList.find((p) => p.id === view.id) : undefined;
  const shown: ProjectView | undefined = view?.kind === "scan" ? undefined : (picked ?? firstVisible);

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
  const loading = !data || projects.isPending;

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
      </PageHeader>

      <SshNotice className="mb-3" />

      {repos.isError && !data ? (
        <ServerError error={repos.error} onRetry={() => void repos.refetch()} retrying={repos.isFetching} />
      ) : (
        <ListDetail>
          <ListPane
            label="Projects"
            footer={
              <Button
                variant="ghost"
                aria-pressed={shown === undefined}
                className={cn("w-full justify-start", shown === undefined && ROW_SELECTED)}
                onClick={() => setView({ kind: "scan" })}
              >
                <FolderPlus aria-hidden="true" />
                Register a repo
                <span className="ml-auto flex items-center gap-1.5 font-mono text-xs font-normal text-fg-faint">
                  {problemRoots.length > 0 && (
                    <>
                      <Dot tone="amber" size={6} />
                      <span className="sr-only">A project folder needs you. </span>
                    </>
                  )}
                  <span className="tnum">{notRegistered}</span>
                  <span className="sr-only"> not registered</span>
                </span>
              </Button>
            }
          >
            {loading ? (
              <div aria-busy="true" className="flex flex-col gap-2 p-1">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-11 rounded-md" />
                ))}
              </div>
            ) : groups.length === 0 ? (
              <p className="px-2 pt-2 text-sm text-fg-faint text-pretty">
                {terms.length > 0
                  ? "No project matches."
                  : orgFilter !== undefined && projectList.length > 0
                    ? "This workspace has no projects yet."
                    : "No projects yet. Register a repo to use it in tasks."}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {groups.map((group) => {
                  const org = orgLabel(group.org, orgList);
                  const key = orgList.find((o) => o.id === group.org)?.key ?? group.org;
                  return (
                    <section key={group.org} aria-label={org.name} className="flex flex-col gap-px">
                      <div className="flex h-8 items-center gap-2 pl-2">
                        <OrgBadge label={badgeLetters(key)} color={org.color} size="xs" />
                        <h2 className="min-w-0 truncate text-sm font-medium text-fg-soft">{org.name}</h2>
                        <span className="tnum font-mono text-xs text-fg-faint">{group.items.length}</span>
                      </div>
                      <ul aria-label={`Projects of ${org.name}`} className="flex flex-col gap-px">
                        {group.items.map((project) => (
                          <ProjectListRow
                            key={project.id}
                            project={project}
                            repo={repoOf(project)}
                            home={home}
                            terms={terms}
                            selected={shown?.id === project.id}
                            onSelect={() => setView({ kind: "project", id: project.id })}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </ListPane>

          {loading ? (
            <DetailPane label="Loading">
              <Skeleton className="mt-5 h-40 rounded-lg" />
            </DetailPane>
          ) : shown ? (
            <ProjectDetail
              key={shown.id}
              project={shown}
              repo={repoOf(shown)}
              projects={projectList}
              orgs={orgList}
              home={home}
              onRemove={() => {
                setRemoveError(undefined);
                setRemoving(shown);
              }}
            />
          ) : (
            <ScanDetail
              roots={roots}
              projects={projectList}
              home={home}
              terms={terms}
              query={deferred.trim()}
              scanning={scanning}
              scannedAt={data.scannedAt}
              now={now}
              onRegister={(repo) => {
                setView({ kind: "scan" });
                setRegistering(repo);
              }}
              onClearSearch={() => setQuery("")}
            />
          )}
        </ListDetail>
      )}

      {registering && <RegisterDialog repo={registering} onClose={() => setRegistering(null)} />}
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
                setView(undefined);
              },
              onError: (error) => setRemoveError(error.message),
            })
          }
        />
      )}
    </div>
  );
}

/**
 * The repos in the workspace roots that are not projects yet, each with Register, then the roots
 * themselves: what majhi scans, whether it can see them, and the way to change them.
 */
function ScanDetail({
  roots,
  projects,
  home,
  terms,
  query,
  scanning,
  scannedAt,
  now,
  onRegister,
  onClearSearch,
}: {
  roots: readonly RootScan[];
  projects: readonly ProjectView[];
  home: string;
  terms: readonly string[];
  query: string;
  scanning: boolean;
  scannedAt: string;
  now: number;
  onRegister: (repo: Repo) => void;
  onClearSearch: () => void;
}) {
  const mount = useMountNow(home);
  const [editingRoots, setEditingRoots] = useState(false);
  const searching = terms.length > 0;
  const unregistered = filterRoots(
    roots.map((root) => ({
      ...root,
      repos: root.repos.filter((r) => projectForPath(projects, r.path) === undefined),
    })),
    terms,
  ).filter((root) => root.repos.length > 0);
  const count = unregistered.reduce((n, r) => n + r.repos.length, 0);
  const problemRoots = roots.filter((r) => !r.mounted || r.error);
  const totalRepos = roots.reduce((n, r) => n + r.repos.length, 0);

  return (
    <DetailPane
      label="Register a repo"
      head={
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-md leading-6 font-semibold">Register a repo</h2>
            <p className="truncate text-sm text-fg-muted">
              {searching
                ? `${plural(count, "repo")} not registered match the search.`
                : `${plural(count, "repo")} in your project folders ${count === 1 ? "is" : "are"} not registered yet.`}
            </p>
          </div>
        </div>
      }
    >
      <div aria-busy={scanning} className={cn("flex flex-col transition-opacity", scanning && "opacity-70")}>
        {!searching && (
          <DetailSection
            title="Project folders"
            note={
              <>
                Scanned{" "}
                <time dateTime={scannedAt} title={new Date(scannedAt).toLocaleString()}>
                  {formatAgo(scannedAt, now)}
                </time>
                . Press <Kbd>r</Kbd> to scan again.
              </>
            }
            className="border-t-0"
            actions={
              <Button size="sm" onClick={() => setEditingRoots(true)}>
                <FolderCog aria-hidden="true" />
                Edit folders
              </Button>
            }
          >
            <ul aria-label="Project folders" className="flex flex-col">
              {roots.map((root) => (
                <li
                  key={root.path}
                  className="flex min-h-9 min-w-0 items-center gap-3 border-t border-line py-1.5 text-sm first:border-t-0"
                >
                  <span className="min-w-0 truncate font-mono text-fg" title={root.path}>
                    {collapseHome(root.path, home)}
                  </span>
                  <span className="shrink-0 text-xs text-fg-faint">{plural(root.repos.length, "repo")}</span>
                  <span
                    className={cn(
                      "ml-auto flex shrink-0 items-center gap-1.5 text-xs",
                      root.error ? "text-red" : root.mounted ? "text-green" : "text-amber",
                    )}
                  >
                    <Dot tone={root.error ? "red" : root.mounted ? "green" : "amber"} size={7} />
                    {root.error ? "Scan failed" : root.mounted ? "Scanned" : "Not mounted"}
                  </span>
                </li>
              ))}
            </ul>
            {problemRoots.length > 0 && (
              <div className="flex flex-col gap-2">
                {problemRoots.map((root) => (
                  <RootProblem
                    key={root.path}
                    root={root}
                    home={home}
                    onMount={mount.canMount ? mount.mountNow : undefined}
                    mounting={mount.pending}
                  />
                ))}
              </div>
            )}
          </DetailSection>
        )}

        {searching && count === 0 ? (
          <NoMatches query={query} onClear={onClearSearch} />
        ) : totalRepos === 0 && problemRoots.length === 0 ? (
          <p className="pt-5 text-base text-fg-muted text-pretty">
            majhi found no git repos in{" "}
            <span className="font-mono text-fg-soft">
              {roots.map((r) => collapseHome(r.path, home)).join(", ")}
            </span>
            . It looks 4 levels deep and skips hidden folders and node_modules.
          </p>
        ) : count === 0 ? (
          <p className="pt-5 text-base text-fg-muted">Every repo in your project folders is registered.</p>
        ) : (
          unregistered.map((root, i) => (
            <RootList
              key={root.path}
              root={root}
              home={home}
              terms={terms}
              first={i === 0 && searching}
              onRegister={onRegister}
            />
          ))
        )}
      </div>
      {editingRoots && <EditRootsDialog onClose={() => setEditingRoots(false)} />}
      {mount.modal}
    </DetailPane>
  );
}

function RootList({
  root,
  home,
  terms,
  first,
  onRegister,
}: {
  root: RootScan;
  home: string;
  terms: readonly string[];
  first: boolean;
  onRegister: (repo: Repo) => void;
}) {
  const label = collapseHome(root.path, home);
  return (
    <DetailSection
      title={`Not registered in ${label}`}
      note={plural(root.repos.length, "repo")}
      className={cn(first && "border-t-0")}
    >
      <ul aria-label={`Repos in ${label}`} className="flex flex-col">
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
    </DetailSection>
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
      className="flex flex-col gap-2 rounded-lg border border-amber-line bg-amber-wash px-4 py-3"
    >
      <div className="flex items-center gap-2.5">
        <FolderX aria-hidden="true" className="size-4 text-amber" />
        <h3 className="font-mono text-sm font-medium">{label}</h3>
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
        <p className="flex items-start gap-2 text-sm text-red">
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
      <h3 className="flex items-center gap-2 text-md font-semibold">
        <SearchX aria-hidden="true" className="size-4 text-fg-faint" />
        No repos match <span className="font-mono">“{query}”</span>
      </h3>
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

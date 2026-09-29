import {
  collapseHome,
  type ProjectView,
  RESTART_COMMAND,
  type Repo,
  type ReposResponse,
  type RootScan,
} from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CircleAlert,
  FolderCog,
  FolderGit2,
  FolderSync,
  FolderX,
  RefreshCw,
  Search,
  SearchX,
  X,
} from "lucide-react";
import * as m from "motion/react-m";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CenteredPage } from "@/components/centered-page";
import { InlineCommand } from "@/components/command-line";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { useToast } from "@/components/ui/toast";
import { ServerError } from "@/features/home/server-error";
import { RestartingCard } from "@/features/roots/restarting-card";
import { cn } from "@/lib/cn";
import { formatAgo, formatDuration, plural } from "@/lib/format";
import { reloadAfterRestart, useHostStatus, useRemount, useRepos, useRescan } from "@/lib/queries";
import { useProjects, useRemoveProject } from "@/lib/task-queries";
import { useCopy } from "@/lib/use-copy";
import { useNow } from "@/lib/use-now";
import { filterRoots, searchTerms } from "./filter";
import { projectForPath } from "./project-model";
import { RegisterDialog } from "./register-dialog";
import { RepoDetails } from "./repo-details";
import { RepoRow, rowId } from "./repo-row";
import { ReposSkeleton } from "./repos-skeleton";
import { SshNotice } from "./ssh-notice";

/** Mounts the roots majhi cannot see, through the host helper. */
interface MountAction {
  run: () => void;
  pending: boolean;
}

export function ReposScreen({ home }: { home: string }) {
  const repos = useRepos(true);
  const host = useHostStatus();
  const remount = useRemount();
  const client = useQueryClient();
  const toast = useToast();
  const [restarting, setRestarting] = useState<readonly string[] | null>(null);
  const canMount = host.data?.connected === true && host.data.info?.canRemount === true;

  function mountNow() {
    if (remount.isPending) return;
    remount.mutate(undefined, {
      onSuccess: (result) => {
        if (result.remount === "restarting") {
          setRestarting(result.unmounted);
        } else if (result.remount === "manual") {
          toast("majhi cannot remount on its own", {
            detail: `Run ${RESTART_COMMAND} on your machine`,
            tone: "error",
          });
        } else {
          void reloadAfterRestart(client).then(() => toast("Already mounted"));
        }
      },
      onError: (error) => toast("Could not mount", { detail: error.message, tone: "error" }),
    });
  }

  if (restarting) {
    const done = () => setRestarting(null);
    return (
      <CenteredPage>
        <RestartingCard
          roots={restarting}
          home={home}
          continueLabel="Back to repos"
          onBack={() => {
            done();
            toast("Roots mounted");
          }}
          onContinue={done}
        />
      </CenteredPage>
    );
  }

  const mount = canMount ? { run: mountNow, pending: remount.isPending } : null;
  if (repos.data) return <ReposView data={repos.data} home={home} mount={mount} />;
  if (repos.isError) {
    return (
      <ServerError error={repos.error} onRetry={() => void repos.refetch()} retrying={repos.isFetching} />
    );
  }
  return <ReposSkeleton />;
}

function ReposView({ data, home, mount }: { data: ReposResponse; home: string; mount: MountAction | null }) {
  const rescan = useRescan();
  const copy = useCopy();
  const toast = useToast();
  const now = useNow(30_000);
  const projects = useProjects().data;
  const removeProject = useRemoveProject();
  const [dialog, setDialog] = useState<{ repo: Repo; project?: ProjectView } | null>(null);
  const [removing, setRemoving] = useState<ProjectView | null>(null);
  const [removeError, setRemoveError] = useState<string | undefined>();
  const projectOf = useCallback((path: string) => projectForPath(projects ?? [], path), [projects]);
  const onRegister = useCallback((repo: Repo) => setDialog({ repo }), []);
  const onEdit = useCallback((repo: Repo, project: ProjectView) => setDialog({ repo, project }), []);
  const onRemove = useCallback((project: ProjectView) => {
    setRemoveError(undefined);
    setRemoving(project);
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const terms = useMemo(() => searchTerms(deferredQuery), [deferredQuery]);

  const roots = useMemo(
    () =>
      data.roots.map((root) => ({
        ...root,
        repos: root.repos.toSorted((a, b) => a.relPath.localeCompare(b.relPath)),
      })),
    [data],
  );
  const total = roots.reduce((sum, root) => sum + root.repos.length, 0);
  const visible = useMemo(() => filterRoots(roots, terms), [roots, terms]);
  const flat = useMemo(() => visible.flatMap((root) => root.repos), [visible]);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selectedIndex = Math.max(
    0,
    flat.findIndex((repo) => repo.path === selectedPath),
  );
  const selected = flat[selectedIndex];
  const scrollOnSelect = useRef(false);

  useEffect(() => {
    if (!selected || !scrollOnSelect.current) return;
    scrollOnSelect.current = false;
    document.getElementById(rowId(selected.path))?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const move = useCallback(
    (delta: number) => {
      const next = flat[Math.min(flat.length - 1, Math.max(0, selectedIndex + delta))];
      if (!next) return;
      scrollOnSelect.current = true;
      setSelectedPath(next.path);
    },
    [flat, selectedIndex],
  );

  const copyPath = useCallback((path: string) => void copy(path, collapseHome(path, home)), [copy, home]);
  const onSelect = useCallback((path: string) => setSelectedPath(path), []);

  const runRescan = useCallback(() => {
    if (rescan.isPending) return;
    rescan.mutate(undefined, {
      onSuccess: (result) => {
        const found = result.roots.reduce((sum, root) => sum + root.repos.length, 0);
        toast("Rescanned", { detail: `${plural(found, "repo")} in ${formatDuration(result.durationMs)}` });
      },
      onError: (error) => toast("Rescan failed", { detail: error.message, tone: "error" }),
    });
  }, [rescan, toast]);

  // Global keys: j/k or arrows move, Enter or o copies, / searches, r rescans.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const onControl = target !== null && target.closest("button, a, summary") !== null;
      const onRow = target?.closest("[data-repo-row]") != null;

      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          move(1);
          break;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          move(-1);
          break;
        case "Enter":
          if (onControl && !onRow) return;
          event.preventDefault();
          if (selected) copyPath(selected.path);
          break;
        case "o":
          if (selected) copyPath(selected.path);
          break;
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case "r":
          runRescan();
          break;
        case "Escape":
          if (query !== "") setQuery("");
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [move, selected, copyPath, runRescan, query]);

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selected) copyPath(selected.path);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query !== "") setQuery("");
      else event.currentTarget.blur();
    }
  }

  const searching = terms.length > 0;
  const scanning = rescan.isPending;
  const unmountedOrFailed = roots.some((root) => !root.mounted || root.error);
  const registered = roots.reduce((sum, root) => sum + root.repos.filter((r) => r.registered).length, 0);

  return (
    <main aria-labelledby="repos-title" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 id="repos-title" className="text-lg font-semibold">
            Repos
          </h1>
          <span className="font-mono text-md text-fg-muted tabular-nums" aria-live="polite">
            {searching ? `${flat.length} of ${total}` : total}
          </span>
        </div>
        <p className="text-sm text-fg-faint">
          in {plural(roots.length, "root")}
          {registered > 0 && ` · ${registered} registered`}
          {" · scanned "}
          <time dateTime={data.scannedAt} title={new Date(data.scannedAt).toLocaleString()}>
            {formatAgo(data.scannedAt, now)}
          </time>
          {` in ${formatDuration(data.durationMs)}`}
        </p>
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
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
              placeholder="Search name, path, remote, host"
              aria-label="Search repos"
              aria-keyshortcuts="/"
              className="peer pr-9 pl-8 [&::-webkit-search-cancel-button]:hidden"
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
                className="absolute top-1/2 right-0.5 size-6 -translate-y-1/2"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
          <Button variant="secondary" onClick={runRescan} disabled={scanning} aria-keyshortcuts="r">
            <RefreshCw aria-hidden="true" className={cn(scanning && "animate-spin")} />
            {scanning ? "Scanning" : "Rescan"}
            <Kbd className="ml-0.5 hidden sm:inline-flex">R</Kbd>
          </Button>
          <Button asChild variant="ghost">
            <Link to="/settings/roots">
              <FolderCog aria-hidden="true" />
              Edit roots
            </Link>
          </Button>
        </div>
      </div>

      <SshNotice />

      <div className="relative flex min-h-0 flex-1">
        {scanning && (
          <div
            role="progressbar"
            aria-label="Scanning workspace roots"
            className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden"
          >
            <div className="h-full w-2/5 animate-scan bg-amber" />
          </div>
        )}

        <m.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          aria-busy={scanning}
          className={cn(
            "flex min-w-0 flex-1 flex-col overflow-auto transition-opacity duration-200",
            scanning && "opacity-70",
          )}
        >
          {total === 0 && !unmountedOrFailed ? (
            <NoRepos roots={roots} home={home} onRescan={runRescan} scanning={scanning} />
          ) : searching && flat.length === 0 ? (
            <NoMatches query={deferredQuery.trim()} onClear={() => setQuery("")} />
          ) : (
            visible.map((root) => (
              <RootGroup key={root.path} root={root} home={home} searching={searching} mount={mount}>
                {root.repos.map((repo) => (
                  <RepoRow
                    key={repo.path}
                    repo={repo}
                    selected={repo === selected}
                    terms={terms}
                    onSelect={onSelect}
                    onOpen={copyPath}
                    project={projectOf(repo.path)}
                    onRegister={onRegister}
                    onEdit={onEdit}
                    onRemove={onRemove}
                  />
                ))}
              </RootGroup>
            ))
          )}
        </m.div>

        <RepoDetails
          repo={selected}
          home={home}
          onCopyPath={() => selected && copyPath(selected.path)}
          project={selected ? projectOf(selected.path) : undefined}
        />
      </div>
      {dialog && (
        <RegisterDialog repo={dialog.repo} project={dialog.project} onClose={() => setDialog(null)} />
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

      <footer className="hidden h-8 shrink-0 items-center gap-4 border-t border-line bg-panel px-4 text-xs text-fg-faint md:flex">
        <KeyHint keys={["J", "K"]} label="move" />
        <KeyHint keys={["Enter"]} label="copy path" />
        <KeyHint keys={["/"]} label="search" />
        <KeyHint keys={["R"]} label="rescan" />
        <span className="ml-auto">Double-click a row to copy its path</span>
      </footer>
    </main>
  );
}

function RootGroup({
  root,
  home,
  searching,
  mount,
  children,
}: {
  root: RootScan;
  home: string;
  searching: boolean;
  mount: MountAction | null;
  children: ReactNode;
}) {
  const label = collapseHome(root.path, home);
  const headingId = `root-${encodeURIComponent(root.path)}`;
  return (
    <section aria-labelledby={headingId} className="shrink-0">
      <div className="sticky top-0 z-10 flex h-9 items-center gap-2.5 border-b border-line bg-canvas px-4">
        {root.mounted ? (
          <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
        ) : (
          <FolderX aria-hidden="true" className="size-3.5 shrink-0 text-amber" />
        )}
        <h2
          id={headingId}
          className="min-w-0 truncate font-mono text-sm font-medium text-fg"
          title={root.path}
        >
          {label}
        </h2>
        {root.mounted && (
          <span className="font-mono text-xs text-fg-faint tabular-nums">
            {plural(root.repos.length, "repo")}
          </span>
        )}
        {!root.mounted && <Badge tone="amber">not mounted</Badge>}
        {root.error && <Badge tone="red">scan failed</Badge>}
      </div>

      {!root.mounted &&
        (mount ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-3 pr-4 pl-[2.625rem]">
            <p className="text-base text-fg-muted">
              majhi cannot see this folder yet. Mounting it restarts majhi for a few seconds.
            </p>
            <Button variant="secondary" size="sm" onClick={mount.run} disabled={mount.pending}>
              <FolderSync aria-hidden="true" />
              {mount.pending ? "Mounting" : "Mount now"}
            </Button>
          </div>
        ) : (
          <p className="border-b border-line py-3 pr-4 pl-[2.625rem] text-base leading-7 text-fg-muted">
            majhi cannot see this folder yet. Roots are mounted when majhi starts. Run{" "}
            <InlineCommand command={RESTART_COMMAND} /> on your machine, then rescan.
          </p>
        ))}

      {root.error && (
        <p className="flex items-start gap-2 border-b border-line py-3 pr-4 pl-[2.625rem] font-mono text-sm text-red">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{root.error}</span>
        </p>
      )}

      {root.mounted && !root.error && root.repos.length === 0 && !searching && (
        <p className="border-b border-line py-3 pr-4 pl-[2.625rem] text-base text-fg-faint">
          No git repos in this folder. majhi looks 4 levels deep and skips hidden folders and node_modules.
        </p>
      )}

      {root.repos.length > 0 && <ul className="py-1">{children}</ul>}
    </section>
  );
}

function NoRepos({
  roots,
  home,
  onRescan,
  scanning,
}: {
  roots: readonly RootScan[];
  home: string;
  onRescan: () => void;
  scanning: boolean;
}) {
  return (
    <div className="flex flex-1 justify-center px-6 pt-[14vh]">
      <div className="flex max-w-[460px] flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-md font-semibold">No git repos found</h2>
          <p className="text-base text-fg-muted text-pretty">
            majhi looked in{" "}
            <span className="font-mono text-fg-soft">
              {roots.map((root) => collapseHome(root.path, home)).join(", ")}
            </span>{" "}
            up to 4 levels deep. It skips hidden folders, node_modules and the tasks folder.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onRescan} disabled={scanning}>
            <RefreshCw aria-hidden="true" className={cn(scanning && "animate-spin")} />
            Rescan
          </Button>
          <Button asChild variant="ghost">
            <Link to="/settings/roots">
              <FolderCog aria-hidden="true" />
              Edit roots
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex flex-1 justify-center px-6 pt-[14vh]">
      <div className="flex max-w-[460px] flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-md font-semibold">
            <SearchX aria-hidden="true" className="size-4 text-fg-faint" />
            No repos match <span className="font-mono">“{query}”</span>
          </h2>
          <p className="text-base text-fg-muted">
            Search checks names, paths, branches, remote URLs, hosts and SSH aliases.
          </p>
        </div>
        <div>
          <Button variant="secondary" onClick={onClear}>
            Clear search
            <Kbd className="ml-0.5">Esc</Kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex gap-0.5">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
      {label}
    </span>
  );
}

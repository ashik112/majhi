import { type WikiPageId, WikiPageIdSchema, type WikiSource, type WikiStatus } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BookText } from "lucide-react";
import { useMemo, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane, ListDetail } from "@/components/ui/list-detail";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { describeError } from "@/lib/errors";
import { useOrgFilter } from "@/lib/org-filter";
import { useProjects } from "@/lib/task-queries";
import { useWiki, useWikiPages, useWikiSystem } from "@/lib/wiki-queries";
import type { AppSearch } from "@/router";
import { COPY } from "./copy";
import { gapCount } from "./model";
import { type ListEntry, PageList } from "./page-list";
import { type LoadedPage, PageView } from "./page-view";
import { SourceViewer } from "./source-viewer";
import { UpdateDialog } from "./update-dialog";
import { useWikiWorkspaces } from "./use-wiki-switch";
import { PHASE_WORDS, WHOLE, WikiHeader } from "./wiki-header";
import { WikiOff } from "./wiki-off";

/** The URL value of `scope` that shows the workspace's own pages. */
const WORKSPACE_SCOPE = "workspace";

/**
 * The Wiki page (docs/design/wiki.md, section 8): a project's architecture as pages, each claim with the file
 * and line behind it, or the whole workspace's: how its repos connect. The workspace is the sidebar's filter,
 * shown here as a picker; the project (or `scope=workspace`) and the page are in the URL.
 */
export function WikiView() {
  const { org: filter, setOrg } = useOrgFilter();
  const { workspaces } = useWikiWorkspaces();
  const projects = useProjects();
  // With All picked, the first workspace that has the wiki on and projects to read, so the page opens on something.
  const withProjects = (id: string) => (projects.data ?? []).some((p) => p.org === id);
  const fallback =
    workspaces.find((w) => w.enabled && withProjects(w.org.id)) ??
    workspaces.find((w) => w.enabled) ??
    workspaces[0];
  const picked = workspaces.find((w) => w.org.id === filter);
  const workspace = picked ?? (projects.isPending ? undefined : fallback);
  if (workspace === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <RowsSkeleton rows={6} height={44} />
      </div>
    );
  }
  return (
    <Scope
      key={workspace.org.id}
      workspaces={workspaces}
      workspace={workspace}
      onOrg={(org) => setOrg(org)}
    />
  );
}

/** The status of a whole workspace as one line: the commits its projects are behind in all, and the most behind one's build. */
function workspaceStatus(org: string, statuses: readonly WikiStatus[]): WikiStatus | undefined {
  if (statuses.length === 0) return undefined;
  const worst = [...statuses].sort((a, b) => (b.behind ?? 0) - (a.behind ?? 0))[0];
  if (worst === undefined) return undefined;
  const behind = statuses.reduce((n, s) => n + (s.behind ?? 0), 0);
  const running = statuses.find((s) => s.running);
  const lastError = statuses.find((s) => s.lastError !== undefined)?.lastError;
  const base = {
    org,
    project: worst.project,
    changed: statuses.flatMap((s) => s.changed),
    oldRules: statuses.some((s) => s.oldRules),
    failed: [...new Set(statuses.flatMap((s) => s.failed))],
    flowsNotChosen: statuses.some((s) => s.flowsNotChosen),
    ...(lastError === undefined ? {} : { lastError }),
    ...(worst.builtCommit === undefined ? {} : { builtCommit: worst.builtCommit }),
    ...(worst.behind === undefined ? {} : { behind }),
  };
  return running?.running
    ? { ...base, running: true, phase: running.phase, done: running.done, total: running.total }
    : { ...base, running: false };
}

function Scope({
  workspaces,
  workspace,
  onOrg,
}: {
  workspaces: ReturnType<typeof useWikiWorkspaces>["workspaces"];
  workspace: ReturnType<typeof useWikiWorkspaces>["workspaces"][number];
  onOrg: (org: string) => void;
}) {
  const org = workspace.org.id;
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const projectList = useProjects();
  const projects = useMemo(
    () => (projectList.data ?? []).filter((p) => p.org === org).map((p) => p.id),
    [projectList.data, org],
  );
  const whole = search.scope === WORKSPACE_SCOPE && projects.length > 0;
  const project = whole ? undefined : (projects.find((p) => p === search.project) ?? projects[0]);
  const on = workspace.enabled;
  // The workspace's own query carries every project's state, which the picker shows.
  const everything = useWiki(on ? org : undefined, undefined);
  const own = useWiki(on && project !== undefined ? org : undefined, project);
  const wiki = whole ? everything : own;
  const summaries = useMemo(() => wiki.data?.pages ?? [], [wiki.data]);
  const reads = useWikiPages(
    on ? org : undefined,
    project,
    summaries.map((s) => s.id),
  );
  const statuses = useMemo(() => everything.data?.status ?? [], [everything.data]);
  const commits = useMemo(
    () =>
      statuses.flatMap((s) =>
        s.builtCommit === undefined ? [] : [{ project: s.project, commit: s.builtCommit }],
      ),
    [statuses],
  );
  const status = whole
    ? workspaceStatus(org, statuses)
    : (own.data?.status.find((s) => s.project === project) ?? statuses.find((s) => s.project === project));
  const changed = useMemo(() => new Set(status?.changed ?? []), [status]);
  // A page that failed belongs to one project, so the workspace's own list marks none.
  const failed = useMemo(() => new Set(whole ? [] : (status?.failed ?? [])), [status, whole]);
  const loaded = useMemo<LoadedPage[]>(
    () =>
      summaries.flatMap((summary, i) => {
        const read = reads[i]?.data;
        return read === undefined ? [] : [{ summary, page: read.page, notes: read.notes }];
      }),
    [summaries, reads],
  );
  const [open, setOpen] = useState<WikiSource>();
  const [updating, setUpdating] = useState<{ page?: WikiPageId } | undefined>();

  /** Go to a project (or the whole workspace) and, when given, one of its pages. */
  const go = (to: { project: string | undefined; id?: WikiPageId }) =>
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => {
        const { id: _id, project: _project, scope: _scope, ...rest } = prev;
        return {
          ...rest,
          ...(to.project === undefined ? { scope: WORKSPACE_SCOPE } : { project: to.project }),
          ...(to.id === undefined ? {} : { id: to.id }),
        };
      },
      replace: true,
    });

  const wanted = WikiPageIdSchema.safeParse(search.id).data;
  const selected =
    summaries.find((s) => s.id === wanted) ?? summaries.find((s) => s.kind === "overview") ?? summaries[0];
  const entries = useMemo<ListEntry[]>(
    () =>
      summaries.map((summary, i) => {
        const page = reads[i]?.data?.page;
        const sources = page?.claims.flatMap((c) => c.sources.map((s) => s.path)) ?? [];
        return { summary, page, stale: sources.some((p) => changed.has(p)), failed: failed.has(summary.id) };
      }),
    [summaries, reads, changed, failed],
  );
  const system = useWikiSystem(on ? org : undefined);
  const items = useMemo(
    () => gapCount(loaded, system.data, project) + failed.size + (status?.flowsNotChosen ? 1 : 0),
    [loaded, system.data, project, status, failed],
  );
  const current = loaded.find((l) => l.summary.id === selected?.id);
  const scopeName = whole ? workspace.org.name : (project ?? "");

  let body: React.ReactNode;
  if (!on) {
    body = <WikiOff workspace={workspace} />;
  } else if (projectList.isPending) {
    body = <RowsSkeleton rows={8} height={44} />;
  } else if (projectList.isError) {
    body = (
      <Problem icon={<BookText />} title="Could not load the wiki" body={describeError(projectList.error)} />
    );
  } else if (project === undefined && !whole) {
    body = (
      <Problem
        icon={<BookText />}
        title={`${workspace.org.name} has no projects yet`}
        body="The wiki is built for a project. Register one and it can be read."
      >
        <PageLink page="projects" className="text-accent-text hover:underline">
          Register a project
        </PageLink>
      </Problem>
    );
  } else if (wiki.isPending) {
    body = <RowsSkeleton rows={8} height={44} />;
  } else if (wiki.isError) {
    body = <Problem icon={<BookText />} title="Could not load the wiki" body={describeError(wiki.error)} />;
  } else if (summaries.length === 0 || current === undefined) {
    body = (
      <ListDetail>
        <DetailPane label="Wiki page">
          <NoPages
            name={scopeName}
            building={summaries.length > 0}
            status={status}
            onBuild={() => setUpdating({})}
          />
        </DetailPane>
      </ListDetail>
    );
  } else {
    body = (
      <ListDetail>
        <PageList
          entries={entries}
          selected={selected?.id}
          openItems={items}
          notWritten={[...failed].filter((id) => !summaries.some((s) => s.id === id))}
          flowsNotChosen={status?.flowsNotChosen === true}
          workspace={whole}
          onSelect={(id) => go({ project, id })}
        />
        <PageView
          page={current.page}
          scope={{ org, project }}
          changed={changed}
          behind={status?.behind}
          all={loaded}
          projects={projects}
          system={system.data}
          onOpen={setOpen}
          onGo={(id) => go({ project, id })}
          onGoPage={(to, id) => go({ project: to, id })}
          onGoProject={(p) => go({ project: p })}
          onUpdatePage={(id) => setUpdating({ page: id })}
          notes={current.notes}
          failed={failed}
          flowsNotChosen={status?.flowsNotChosen === true}
          onRetry={() => setUpdating({})}
        />
      </ListDetail>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WikiHeader
        workspaces={workspaces}
        org={org}
        onOrg={onOrg}
        projects={on ? projects.map((id) => ({ id, status: statuses.find((s) => s.project === id) })) : []}
        scope={whole ? WHOLE : project}
        onScope={(p) => go({ project: p === WHOLE ? undefined : p })}
        status={status}
        commits={whole ? commits : undefined}
        onUpdate={
          on && (project !== undefined || whole) && summaries.length > 0 ? () => setUpdating({}) : undefined
        }
      />
      {body}
      {open !== undefined && (
        <SourceViewer
          org={org}
          project={open.repo}
          source={open}
          moved={changed.has(open.path)}
          onClose={() => setOpen(undefined)}
        />
      )}
      {updating !== undefined && (
        <UpdateDialog
          org={org}
          {...(project === undefined ? {} : { project })}
          {...(updating.page === undefined ? {} : { page: updating.page })}
          first={(whole ? statuses : status === undefined ? [] : [status]).every(
            (s) => s.builtCommit === undefined,
          )}
          onClose={() => setUpdating(undefined)}
        />
      )}
    </div>
  );
}

/** Nothing built yet for this project or workspace: one button builds it, then the build's progress or its error. */
function NoPages({
  name,
  building,
  status,
  onBuild,
}: {
  name: string;
  building: boolean;
  status: WikiStatus | undefined;
  onBuild: () => void;
}) {
  if (status?.running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center" role="status">
        <h2 className="flex items-center gap-2 text-md font-semibold">
          <Lamp state="working" />
          {COPY.build.running} {name}
        </h2>
        <p className="text-base text-fg-muted">
          {PHASE_WORDS[status.phase]}
          {status.total > 0 && `, ${status.done} of ${status.total}`}
        </p>
      </div>
    );
  }
  const failed = status?.lastError;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
      <h2 className="text-md font-semibold">
        {building
          ? COPY.build.reading
          : failed !== undefined
            ? COPY.build.failed
            : `${COPY.build.title} for ${name}`}
      </h2>
      {!building && (
        <>
          <p className="max-w-[520px] text-base text-fg-muted text-pretty">{failed ?? COPY.build.body}</p>
          <Button variant="primary" className="mt-2" onClick={onBuild}>
            {failed !== undefined ? COPY.build.again : COPY.build.button}
          </Button>
        </>
      )}
    </div>
  );
}

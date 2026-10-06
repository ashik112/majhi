import { type WikiPageId, WikiPageIdSchema, type WikiSource } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BookText } from "lucide-react";
import { useMemo, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { DetailPane, ListDetail } from "@/components/ui/list-detail";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { describeError } from "@/lib/errors";
import { useOrgFilter } from "@/lib/org-filter";
import { useProjects } from "@/lib/task-queries";
import { useWiki, useWikiPages } from "@/lib/wiki-queries";
import type { AppSearch } from "@/router";
import { openItems } from "./model";
import { type ListEntry, PageList } from "./page-list";
import { type LoadedPage, PageView } from "./page-view";
import { SourceViewer } from "./source-viewer";
import { UpdateDialog } from "./update-dialog";
import { useWikiWorkspaces } from "./use-wiki-switch";
import { WikiHeader } from "./wiki-header";
import { WikiOff } from "./wiki-off";

/**
 * The Wiki page (docs/design/wiki.md, section 8): a project's architecture as pages, each claim with the file
 * and line behind it. The workspace is the sidebar's filter, shown here as a picker; the project and page
 * are in the URL (`?project=&id=`). Phase 1 has no workspace-wide view and no Ask box.
 */
export function WikiView() {
  const { org: filter, setOrg } = useOrgFilter();
  const { workspaces } = useWikiWorkspaces();
  const fallback = workspaces.find((w) => w.enabled) ?? workspaces[0];
  const workspace = workspaces.find((w) => w.org.id === filter) ?? fallback;
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
  const project = projects.find((p) => p === search.project) ?? projects[0];
  const wiki = useWiki(workspace.enabled ? org : undefined, project);
  const summaries = useMemo(() => wiki.data?.pages ?? [], [wiki.data]);
  const reads = useWikiPages(
    workspace.enabled ? org : undefined,
    project,
    summaries.map((s) => s.id),
  );
  const status = wiki.data?.status.find((s) => s.project === project);
  const changed = useMemo(() => new Set(status?.changed ?? []), [status]);
  const loaded = useMemo<LoadedPage[]>(
    () =>
      summaries.flatMap((summary, i) => {
        const page = reads[i]?.data?.page;
        return page === undefined ? [] : [{ summary, page }];
      }),
    [summaries, reads],
  );
  const [open, setOpen] = useState<WikiSource>();
  const [updating, setUpdating] = useState(false);

  const go = (next: { project?: string; id?: WikiPageId }) =>
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => {
        const { id: _id, project: _project, ...rest } = prev;
        const nextProject = next.project ?? project;
        return {
          ...rest,
          ...(nextProject === undefined ? {} : { project: nextProject }),
          ...(next.id === undefined ? {} : { id: next.id }),
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
        return { summary, page, stale: sources.some((p) => changed.has(p)) };
      }),
    [summaries, reads, changed],
  );
  const items = useMemo(() => {
    const { guessed, dropped } = openItems(loaded);
    return guessed.length + dropped.length;
  }, [loaded]);
  const current = loaded.find((l) => l.summary.id === selected?.id);

  let body: React.ReactNode;
  if (!workspace.enabled) {
    body = <WikiOff workspace={workspace} />;
  } else if (projectList.isPending || wiki.isPending) {
    body = <RowsSkeleton rows={8} height={44} />;
  } else if (wiki.isError || projectList.isError) {
    body = (
      <Problem
        icon={<BookText />}
        title="Could not load the wiki"
        body={describeError(wiki.error ?? projectList.error)}
      />
    );
  } else if (project === undefined) {
    body = (
      <Problem
        icon={<BookText />}
        title={`${workspace.org.name} has no projects yet`}
        body="The wiki is built for a project. Add one first."
      >
        <PageLink page="projects" className="text-accent-text hover:underline">
          Open Projects and links
        </PageLink>
      </Problem>
    );
  } else {
    body = (
      <ListDetail>
        <PageList entries={entries} selected={selected?.id} openItems={items} onSelect={(id) => go({ id })} />
        {current !== undefined ? (
          <PageView
            page={current.page}
            changed={changed}
            behind={status?.behind}
            all={loaded}
            onOpen={setOpen}
            onGo={(id) => go({ id })}
          />
        ) : (
          <DetailPane label="Wiki page">
            <NoPages building={summaries.length > 0} onUpdate={() => setUpdating(true)} />
          </DetailPane>
        )}
      </ListDetail>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WikiHeader
        workspaces={workspaces}
        org={org}
        onOrg={onOrg}
        projects={workspace.enabled ? projects : []}
        project={project}
        onProject={(p) => go({ project: p })}
        status={status}
        onUpdate={workspace.enabled && project !== undefined ? () => setUpdating(true) : undefined}
      />
      {body}
      {open !== undefined && project !== undefined && (
        <SourceViewer
          org={org}
          project={project}
          source={open}
          moved={changed.has(open.path)}
          onClose={() => setOpen(undefined)}
        />
      )}
      {updating && project !== undefined && (
        <UpdateDialog org={org} project={project} onClose={() => setUpdating(false)} />
      )}
    </div>
  );
}

function NoPages({ building, onUpdate }: { building: boolean; onUpdate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
      <h2 className="text-md font-semibold">{building ? "Reading the pages" : "No pages yet"}</h2>
      {!building && (
        <>
          <p className="max-w-[420px] text-base text-fg-muted text-pretty">
            Update reads the code and writes the architecture pages, each claim with the file behind it.
          </p>
          <Button variant="primary" className="mt-2" onClick={onUpdate}>
            Update
          </Button>
        </>
      )}
    </div>
  );
}

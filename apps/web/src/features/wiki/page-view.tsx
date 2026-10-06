import type { WikiClaim, WikiPage, WikiPageId, WikiPageSummary, WikiSystemView } from "@majhi/shared";
import { type ReactNode, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailPane } from "@/components/ui/list-detail";
import { AskBar } from "./ask-bar";
import { ComponentBody } from "./component-body";
import { COPY } from "./copy";
import { FlowBody } from "./flow-body";
import { GapsBody } from "./gaps-body";
import { InfraBody } from "./infra-body";
import {
  countClaims,
  folderOf,
  gapCount,
  movedFiles,
  ROLE_LABEL,
  ROLE_TONE,
  roleRowOf,
  tagOf,
} from "./model";
import { OverviewBody } from "./overview-body";
import { BasisMark, type OpenSource, Stat, Text } from "./parts";

/** A page of the scope, with its summary: the gaps view reads them all. */
export interface LoadedPage {
  summary: WikiPageSummary;
  page: WikiPage;
}

/** Everything a page of any kind needs. */
export interface PageProps {
  page: WikiPage;
  /** The workspace, and the project the page belongs to (none: a workspace page). */
  scope: { org: string; project: string | undefined };
  /** Files a newer commit changed. A page or a chip that cites one is marked out of date. */
  changed: ReadonlySet<string>;
  /** Commits the base branch has past the one the page was built from, when it is counted. */
  behind: number | undefined;
  /** Every page of the scope, for what looks across pages (gaps, talks to, used in flows). */
  all: readonly LoadedPage[];
  /** The workspace's projects, for the boxes of the workspace diagram and the answers to a question. */
  projects: readonly string[];
  /** How the projects connect, from the workspace's facts; undefined until it is read. */
  system: WikiSystemView | undefined;
  onOpen: OpenSource;
  /** Go to a page of this scope. */
  onGo: (id: WikiPageId) => void;
  /** Go to a page of any project of the workspace, or of the workspace itself (no project). */
  onGoPage: (project: string | undefined, id: WikiPageId) => void;
  onGoProject: (project: string) => void;
  /** Rewrite just this page: opens the update with what it would cost. */
  onUpdatePage: (id: WikiPageId) => void;
}

/** The page on the right: its head, then the sections its kind has, then the Ask box. */
export function PageView(props: PageProps) {
  const { page, changed, scope } = props;
  const moved = useMemo(() => movedFiles(page, changed), [page, changed]);
  const summaries = useMemo(() => props.all.map((l) => l.summary), [props.all]);
  return (
    <DetailPane
      key={page.id}
      label={page.title}
      head={<Head {...props} />}
      footer={
        <AskBar
          org={scope.org}
          project={scope.project}
          all={props.all}
          summaries={summaries}
          onOpen={props.onOpen}
          onGo={props.onGoPage}
        />
      }
    >
      {moved.length > 0 && (
        <StaleBanner moved={moved} behind={props.behind} page={page} onUpdatePage={props.onUpdatePage} />
      )}
      <Body {...props} stale={moved.length > 0} />
    </DetailPane>
  );
}

function Head({ page, all, scope, system }: PageProps) {
  const n = countClaims(page.claims);
  const built = Object.values(page.builtFrom)[0];
  const workspace = scope.project === undefined;
  const open = page.kind === "gaps" ? gapCount(all, system, scope.project) : n.guessed + page.dropped.length;
  const stats: ReactNode[] = [];
  if (built !== undefined && page.kind !== "gaps" && !workspace) {
    stats.push(
      <span key="built" className="whitespace-nowrap">
        {COPY.stat.builtFrom} <b className="font-mono font-medium text-fg">{built.slice(0, 7)}</b>
      </span>,
    );
  }
  let badge: ReactNode = <Badge className="shrink-0">{tagOf(page.kind, workspace)}</Badge>;
  if (page.kind === "overview" && !workspace) {
    stats.push(
      <Stat key="roles" value={page.roles.length}>
        {COPY.stat.rolesFound(page.roles.length)}
      </Stat>,
    );
  }
  if (page.kind === "overview" && workspace) {
    const diagram = page.diagrams[0];
    const links = diagram?.edges.length ?? 0;
    stats.push(
      <Stat key="repos" value={diagram?.nodes.length ?? 0}>
        {COPY.stat.repos(diagram?.nodes.length ?? 0)}
      </Stat>,
      <Stat key="links" value={links}>
        {COPY.stat.links(links)}
      </Stat>,
      <Stat
        key="proven"
        value={diagram?.edges.filter((e) => e.style !== "dotted" && e.style !== "dashed").length ?? 0}
      >
        {COPY.stat.proven}
      </Stat>,
    );
  }
  if (page.kind === "flow") {
    if (page.body.trim() !== "") {
      stats.push(
        <Text key="summary" className="max-w-[70ch] min-w-0 text-sm text-fg-muted [&_p]:truncate">
          {page.body}
        </Text>,
      );
    }
    stats.push(
      <Stat key="steps" value={n.total}>
        {COPY.stat.step(n.total)}
      </Stat>,
      <Stat key="proven" value={n.proven}>
        {COPY.stat.proven}
      </Stat>,
    );
    if (n.guessed > 0) {
      stats.push(
        <Stat key="guessed" value={n.guessed}>
          {COPY.stat.guessed}
        </Stat>,
      );
    }
  }
  if (page.kind === "component") {
    const overview = all.find((l) => l.page.kind === "overview")?.page;
    const row = roleRowOf(page.id, overview);
    if (row !== undefined) {
      badge = (
        <Badge tone={ROLE_TONE[row.role]} className="shrink-0">
          {ROLE_LABEL[row.role]}
        </Badge>
      );
      stats.push(<span key="tech">{row.tech}</span>);
    }
  }
  if (page.kind === "component" || page.kind === "infra") {
    const folder = folderOf(page);
    if (folder !== undefined) {
      stats.push(
        <span key="folder" className="min-w-0 truncate font-mono text-xs" title={folder}>
          {folder}
        </span>,
      );
    }
    if (n.total > 0) stats.push(<BasisMark key="basis" proven={n.proven * 2 >= n.total} />);
  }
  if (page.kind === "infra") {
    const units = page.claims.filter((c) => c.facts.length > 0).length;
    if (units > 0) {
      stats.unshift(
        <Stat key="units" value={units}>
          {COPY.stat.units(units)}
        </Stat>,
      );
    }
  }
  if (page.kind === "overview" && !workspace) {
    stats.push(
      <Stat key="open" value={open}>
        {COPY.stat.openItems}
      </Stat>,
    );
  }
  if (page.kind === "gaps") {
    stats.push(
      <Stat key="open" value={open}>
        {COPY.stat.toCheck}
      </Stat>,
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <h2 className="min-w-0 truncate text-md leading-6 font-semibold" title={page.title}>
          {page.kind === "gaps" ? COPY.openItemsTitle : page.title}
        </h2>
        {badge}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">{stats}</div>
    </div>
  );
}

function StaleBanner({
  moved,
  behind,
  page,
  onUpdatePage,
}: {
  moved: readonly string[];
  behind: number | undefined;
  page: WikiPage;
  onUpdatePage: (id: WikiPageId) => void;
}) {
  const files = `${moved[0]}${moved.length > 1 ? ` and ${moved.length - 1} more` : ""}`;
  const since = behind === undefined ? COPY.stale.someNewer : COPY.stale.behind(behind);
  return (
    <p
      role="status"
      data-stale-banner=""
      className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-lg border border-amber-line bg-amber-wash px-3 py-2 text-sm text-fg-soft"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber" />
      <span className="min-w-[200px] flex-1 text-pretty">
        {since} <span className="font-mono text-xs">{files}</span>. {COPY.stale.outOfDate}
      </span>
      <Button size="sm" onClick={() => onUpdatePage(page.id)}>
        {COPY.stale.update}
      </Button>
    </p>
  );
}

function Body(props: PageProps & { stale: boolean }) {
  switch (props.page.kind) {
    case "overview":
      return <OverviewBody {...props} />;
    case "flow":
      return <FlowBody {...props} />;
    case "gaps":
      return <GapsBody {...props} />;
    case "component":
      return <ComponentBody {...props} />;
    case "infra":
      return <InfraBody {...props} />;
  }
}

/** The claim a `[n]` points at. */
export function claimOf(page: WikiPage, n: number): WikiClaim | undefined {
  return page.claims.find((c) => c.n === n);
}

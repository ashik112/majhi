import type { DiagramNode, WikiClaim, WikiPageId, WikiRoleRow } from "@majhi/shared";
import { useCallback, useMemo } from "react";
import { cn } from "@/lib/cn";
import { COPY } from "./copy";
import { PageDiagrams } from "./diagrams";
import { CORE_ROLES, pageOfNode, ROLE_LABEL } from "./model";
import type { PageProps } from "./page-view";
import { BasisMark, Block, BodyText, type OpenSource, SourceChip, Text } from "./parts";
import { TalkArrow } from "./talk-arrow";

/** A project's overview: what it is, the stack as tiles, and the picture of how the parts connect. A workspace's: what it is, the repos and how they connect. */
export function OverviewBody(props: PageProps) {
  return props.scope.project === undefined ? (
    <WorkspaceOverview {...props} />
  ) : (
    <ProjectOverview {...props} />
  );
}

function ProjectOverview({ page, all, onOpen, onGo, changed }: PageProps) {
  const claims = useMemo(() => new Map(page.claims.map((c) => [c.n, c])), [page.claims]);
  const missing = CORE_ROLES.filter((r) => !page.roles.some((row) => row.role === r));
  const gaps = all.find((p) => p.page.kind === "gaps");
  const summaries = useMemo(() => all.map((l) => l.summary), [all]);
  const titles = useMemo(() => new Map(summaries.map((s) => [s.id, s.title])), [summaries]);
  const pageOf = useCallback(
    (n: DiagramNode) => {
      const ref = pageOfNode(n, summaries);
      return ref === undefined ? undefined : () => onGo(ref.id);
    },
    [summaries, onGo],
  );
  return (
    <>
      <Block title={COPY.heading.about} first>
        <BodyText page={page} onOpen={onOpen} />
      </Block>
      {page.roles.length > 0 && (
        <Block title={COPY.heading.stack}>
          <div className="grid grid-cols-1 gap-2.5 @[480px]:grid-cols-2 @[720px]:grid-cols-4">
            {page.roles.map((row) => (
              <Tile
                key={`${row.role}:${row.where}`}
                row={row}
                claim={claims.get(row.claim)}
                moved={claims.get(row.claim)?.sources.some((s) => changed.has(s.path)) ?? false}
                pageTitle={row.page === undefined ? undefined : titles.get(row.page)}
                onOpen={onOpen}
                onGo={onGo}
              />
            ))}
          </div>
          {missing.length > 0 && (
            <p className="text-sm text-fg-muted">
              {COPY.stack.notFound} {missing.map((r) => ROLE_LABEL[r].toLowerCase()).join(", ")}.
              {gaps !== undefined && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="cursor-pointer text-accent-text underline-offset-2 hover:underline"
                    onClick={() => onGo(gaps.page.id)}
                  >
                    {COPY.stack.seeGaps}
                  </button>
                  .
                </>
              )}
            </p>
          )}
        </Block>
      )}
      {page.diagrams.length > 0 && (
        <Block title={COPY.heading.systemDiagram}>
          <PageDiagrams specs={page.diagrams} pageOf={pageOf} />
        </Block>
      )}
    </>
  );
}

function WorkspaceOverview({ page, system, onOpen, projects, onGoProject }: PageProps) {
  const pageOf = useCallback(
    (n: DiagramNode) => (projects.includes(n.id) ? () => onGoProject(n.id) : undefined),
    [projects, onGoProject],
  );
  const spec = page.diagrams[0];
  const links = (system?.links ?? []).map((l) => ({
    id: l.id,
    type: l.type,
    label: l.label,
    from: l.from.project,
    to: l.to.project,
    basis: COPY.linkBasis[l.basis],
    sources: [...l.from.sources, ...l.to.sources],
  }));
  return (
    <>
      <Block title={COPY.heading.about} first>
        <BodyText page={page} onOpen={onOpen} />
      </Block>
      {spec !== undefined && (
        <Block title={COPY.heading.systemDiagram}>
          <PageDiagrams specs={page.diagrams} pageOf={pageOf} withLinks />
        </Block>
      )}
      {links.length > 0 && (
        <Block title={COPY.heading.links}>
          <ul className="m-0 flex list-none flex-col p-0">
            {links.map((l) => (
              <li
                key={l.id}
                data-link={l.id}
                className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line py-2 text-base first:border-t-0 first:pt-0"
              >
                <TalkArrow type={l.type} guessed={false} />
                <span className="font-semibold text-fg">{l.from}</span>
                <span className="text-fg-faint">to</span>
                <span className="font-semibold text-fg">{l.to}</span>
                <Text className="text-fg-muted">{`\`${l.label}\``}</Text>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {l.sources.map((s) => (
                    <SourceChip
                      key={`${s.repo}:${s.path}:${s.lines[0]}`}
                      source={s}
                      moved={false}
                      onOpen={onOpen}
                    />
                  ))}
                  <span className="text-sm text-fg-faint">{l.basis}</span>
                  <BasisMark proven />
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </>
  );
}

/**
 * One role. With a component page behind it the tile opens that page and the file line under it opens the
 * proof; without one the whole tile opens the proof.
 */
function Tile({
  row,
  claim,
  moved,
  pageTitle,
  onOpen,
  onGo,
}: {
  row: WikiRoleRow;
  claim: WikiClaim | undefined;
  moved: boolean;
  /** The title of the component page this role names, when that page exists. */
  pageTitle: string | undefined;
  onOpen: OpenSource;
  onGo: (id: WikiPageId) => void;
}) {
  const source = claim?.sources[0];
  const proven = claim?.proven ?? false;
  const style = cn(
    "flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card p-3 text-left shadow-glass",
    proven ? "border-glass-line" : "border-dashed border-amber-line",
  );
  const hover = "transition-colors duration-150 hover:border-line-hover";
  const head = (
    <>
      <span className="flex items-center justify-between gap-2 text-sm text-fg-faint">
        <span className="truncate">{ROLE_LABEL[row.role]}</span>
        <BasisMark proven={proven} />
      </span>
      {pageTitle !== undefined && (
        <span className="block truncate text-body leading-[19px] font-medium text-fg">{pageTitle}</span>
      )}
      <span
        className={cn(
          "line-clamp-2 min-h-[34px] [overflow-wrap:anywhere]",
          pageTitle === undefined
            ? "text-body leading-[19px] font-medium text-fg"
            : "text-sm leading-[17px] text-fg-muted",
        )}
      >
        {row.tech}
      </span>
    </>
  );
  const whereTitle = source === undefined ? row.where : `${row.where} (${source.path}:${source.lines[0]})`;
  const where =
    source === undefined ? (
      <span className="truncate font-mono text-xs text-fg-faint" title={whereTitle}>
        {row.where}
      </span>
    ) : (
      <button
        type="button"
        data-tile-source={`${source.path}:${source.lines[0]}`}
        title={`${COPY.stack.readProof} ${whereTitle}`}
        onClick={() => onOpen(source)}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 self-stretch text-left font-mono text-xs text-fg-faint transition-colors duration-150 hover:text-fg"
      >
        <span className="min-w-0 truncate">{row.where}</span>
        {moved && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber" />}
      </button>
    );
  if (row.page !== undefined && pageTitle !== undefined) {
    const id = row.page;
    return (
      <div data-tile={row.role} className={cn(style, hover)}>
        <button
          type="button"
          data-tile-page={id}
          title={COPY.stack.open(pageTitle)}
          onClick={() => onGo(id)}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left"
        >
          {head}
        </button>
        {where}
      </div>
    );
  }
  if (source === undefined) {
    return (
      <div data-tile={row.role} className={style}>
        {head}
        {where}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-tile={row.role}
      onClick={() => onOpen(source)}
      className={cn(style, hover, "cursor-pointer")}
    >
      {head}
      <span className="truncate font-mono text-xs text-fg-faint" title={whereTitle}>
        {row.where}
      </span>
    </button>
  );
}

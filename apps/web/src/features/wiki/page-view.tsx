import type {
  DiagramSpec,
  WikiClaim,
  WikiPage,
  WikiPageId,
  WikiPageSummary,
  WikiRoleRow,
} from "@majhi/shared";
import { FileText } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { sequenceHeight } from "@/features/diagram/layouts/sequence";
import { DiagramItem } from "@/features/room/diagram-item";
import { type Cites, Markdown } from "@/features/room/markdown";
import { cn } from "@/lib/cn";
import {
  CORE_ROLES,
  countClaims,
  DROP_WORDS,
  folderOf,
  KIND_TAG,
  movedFiles,
  openItems,
  ROLE_LABEL,
  sourcesOf,
} from "./model";
import { BasisMark, type OpenSource, SourceChip, Sources, Stat } from "./parts";

/** A page of the scope, with its summary: the gaps view reads them all. */
export interface LoadedPage {
  summary: WikiPageSummary;
  page: WikiPage;
}

interface Props {
  page: WikiPage;
  /** Files a newer commit changed. A page or a chip that cites one is marked out of date. */
  changed: ReadonlySet<string>;
  /** Commits the base branch has past the one the page was built from, when it is counted. */
  behind: number | undefined;
  /** Every page of the scope, for the gaps view. */
  all: readonly LoadedPage[];
  onOpen: OpenSource;
  onGo: (id: WikiPageId) => void;
}

const FIRST = "border-t-0";

/** The page on the right: its head, then the sections its kind has. */
export function PageView(props: Props) {
  const { page, changed } = props;
  const moved = useMemo(() => movedFiles(page, changed), [page, changed]);
  return (
    <DetailPane key={page.id} label={page.title} head={<Head {...props} />}>
      {moved.length > 0 && <StaleBanner moved={moved} behind={props.behind} />}
      <Body {...props} stale={moved.length > 0} />
    </DetailPane>
  );
}

function Head({ page, all }: Props) {
  const n = countClaims(page.claims);
  const built = Object.values(page.builtFrom)[0];
  const open =
    page.kind === "gaps"
      ? openItems(all).guessed.length + openItems(all).dropped.length
      : n.guessed + page.dropped.length;
  const stats: ReactNode[] = [];
  if (built !== undefined && page.kind !== "gaps") {
    stats.push(
      <span key="built" className="whitespace-nowrap">
        Built from <b className="font-mono font-medium text-fg">{built.slice(0, 7)}</b>
      </span>,
    );
  }
  if (page.kind === "overview") {
    stats.push(
      <Stat key="roles" value={page.roles.length}>
        {page.roles.length === 1 ? "role" : "roles"} found
      </Stat>,
    );
  }
  if (page.kind === "flow") {
    stats.push(
      <Stat key="steps" value={n.total}>
        {n.total === 1 ? "step" : "steps"}
      </Stat>,
      <Stat key="proven" value={n.proven}>
        proven
      </Stat>,
    );
    if (n.guessed > 0) {
      stats.push(
        <Stat key="guessed" value={n.guessed}>
          guessed
        </Stat>,
      );
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
    if (n.total > 0) stats.push(<BasisMark key="basis" proven={n.guessed === 0} />);
  }
  if (page.kind === "overview" || page.kind === "gaps") {
    stats.push(
      <Stat key="open" value={open}>
        {page.kind === "gaps" ? "to check" : "open items"}
      </Stat>,
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <h2 className="min-w-0 truncate text-md leading-6 font-semibold" title={page.title}>
          {page.kind === "gaps" ? "Open items" : page.title}
        </h2>
        <Badge className="shrink-0">{KIND_TAG[page.kind]}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">{stats}</div>
    </div>
  );
}

function StaleBanner({ moved, behind }: { moved: readonly string[]; behind: number | undefined }) {
  const files = `${moved[0]}${moved.length > 1 ? ` and ${moved.length - 1} more` : ""}`;
  const since =
    behind === undefined
      ? "A newer commit"
      : `${behind} commit${behind === 1 ? "" : "s"} since this page was built`;
  return (
    <p
      role="status"
      data-stale-banner=""
      className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-2.5 text-sm text-fg-soft"
    >
      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber" />
      <span className="min-w-0 text-pretty">
        {since} {behind === undefined ? "changed" : "touch"}{" "}
        <span className="font-mono text-xs">{files}</span>. It may be out of date. Update the wiki to refresh
        it.
      </span>
    </p>
  );
}

function Body(props: Props & { stale: boolean }) {
  switch (props.page.kind) {
    case "overview":
      return <Overview {...props} />;
    case "flow":
      return <Flow {...props} />;
    case "gaps":
      return <Gaps {...props} />;
    case "component":
    case "infra":
      return <Plain {...props} />;
  }
}

/** The page's own text, with `[n]` turned into a button that opens claim n's first source. */
function Text({ page, onOpen }: Pick<Props, "page" | "onOpen">) {
  const cites = useMemo<Cites>(() => {
    const byNumber = new Map(page.claims.map((c) => [c.n, c]));
    return {
      known: new Set(byNumber.keys()),
      render: (n) => <CiteButton n={n} claim={byNumber.get(n)} onOpen={onOpen} />,
    };
  }, [page.claims, onOpen]);
  if (page.body.trim() === "") return null;
  return <Markdown text={page.body} size="document" cites={cites} />;
}

function CiteButton({ n, claim, onOpen }: { n: number; claim: WikiClaim | undefined; onOpen: OpenSource }) {
  const source = claim?.sources[0];
  const name = source === undefined ? "No file shows it" : `${source.path}:${source.lines[0]}`;
  const style =
    "mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-sm border px-1 align-baseline font-mono text-[10px] leading-none";
  if (source === undefined) {
    return (
      <span title={name} className={cn(style, "border-dashed border-amber-line text-amber")}>
        {n}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={name}
      data-cite={n}
      onClick={() => onOpen(source)}
      className={cn(
        style,
        "cursor-pointer text-fg-soft hover:bg-raised hover:text-fg",
        claim?.proven === false ? "border-dashed border-amber-line" : "border-line-control",
      )}
    >
      {n}
    </button>
  );
}

/**
 * How tall a diagram's frame is. A sequence is drawn at a readable size, never scaled down, so its frame is
 * as tall as its messages and the pane scrolls, not the frame. Other layouts use the height the page asks for.
 */
function frameHeight(spec: DiagramSpec, fallback: number): number {
  if (spec.layout !== "sequence") return fallback;
  return sequenceHeight(spec.edges.length) + LEGEND_BAR;
}

/** The bar of line kinds under a sequence. */
const LEGEND_BAR = 34;

function Diagrams({
  page,
  title,
  height,
  children,
}: {
  page: WikiPage;
  title: string;
  height: number;
  children?: ReactNode;
}) {
  if (page.diagrams.length === 0 && children === undefined) return null;
  return (
    <DetailSection title={title}>
      {children}
      {page.diagrams.map((spec) => (
        <DiagramItem
          key={spec.title}
          spec={spec}
          height={frameHeight(spec, height)}
          legend={["http", "queue", "data"]}
          fitMin={0.4}
        />
      ))}
    </DetailSection>
  );
}

// Overview ------------------------------------------------------------------------------

function Overview({ page, all, onOpen, onGo, changed }: Props) {
  const claims = useMemo(() => new Map(page.claims.map((c) => [c.n, c])), [page.claims]);
  const missing = CORE_ROLES.filter((r) => !page.roles.some((row) => row.role === r));
  const gaps = all.find((p) => p.page.kind === "gaps");
  const titles = useMemo(() => new Map(all.map((p) => [p.page.id, p.page.title])), [all]);
  return (
    <>
      <DetailSection title="About" className={FIRST}>
        <Text page={page} onOpen={onOpen} />
      </DetailSection>
      {page.roles.length > 0 && (
        <DetailSection title="Stack">
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
              Not found in the code: {missing.map((r) => ROLE_LABEL[r].toLowerCase()).join(", ")}.
              {gaps !== undefined && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="cursor-pointer text-accent-text underline-offset-2 hover:underline"
                    onClick={() => onGo(gaps.page.id)}
                  >
                    See Gaps
                  </button>
                  .
                </>
              )}
            </p>
          )}
        </DetailSection>
      )}
      <Diagrams page={page} title="System diagram" height={440} />
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
  const head = (
    <>
      <span className="flex items-center justify-between gap-2 text-sm text-fg-muted">
        <span className="truncate">{ROLE_LABEL[row.role]}</span>
        <BasisMark proven={proven} />
      </span>
      {pageTitle !== undefined && (
        <span className="mt-1.5 block truncate text-body leading-5 font-semibold text-fg">{pageTitle}</span>
      )}
      <span
        className={cn(
          "block text-fg [overflow-wrap:anywhere]",
          pageTitle === undefined
            ? "mt-1.5 text-body leading-5 font-semibold"
            : "mt-0.5 text-sm text-fg-muted",
        )}
      >
        {row.tech}
      </span>
    </>
  );
  const where = (
    <>
      <span className="min-w-0 truncate">{row.where}</span>
      {moved && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber" />}
    </>
  );
  const whereTitle = source === undefined ? row.where : `${row.where} (${source.path}:${source.lines[0]})`;
  const style = cn(
    "block min-w-0 rounded-xl border bg-field p-3 text-left",
    proven ? "border-line-control" : "border-dashed border-amber-line",
  );
  const hover = "cursor-pointer transition-colors duration-150 hover:border-line-hover hover:bg-raised";
  if (row.page !== undefined && pageTitle !== undefined) {
    const id = row.page;
    return (
      <div data-tile={row.role} className={cn(style, "flex flex-col gap-3", hover)}>
        <button
          type="button"
          data-tile-page={id}
          title={`Open ${pageTitle}`}
          onClick={() => onGo(id)}
          className="flex min-w-0 flex-1 cursor-pointer flex-col justify-start text-left"
        >
          {head}
        </button>
        {source === undefined ? (
          <span className="flex items-center gap-1.5 font-mono text-xs text-fg-faint" title={whereTitle}>
            {where}
          </span>
        ) : (
          <button
            type="button"
            data-tile-source={`${source.path}:${source.lines[0]}`}
            title={`Read the proof: ${whereTitle}`}
            onClick={() => onOpen(source)}
            className="flex min-w-0 cursor-pointer items-center gap-1.5 self-start rounded-md border border-line-control px-1.5 font-mono text-xs leading-5 text-fg-faint transition-colors duration-150 hover:border-line-hover hover:text-fg"
          >
            <FileText aria-hidden="true" className="size-3 shrink-0" />
            {where}
          </button>
        )}
      </div>
    );
  }
  const inner = (
    <>
      {head}
      <span className="mt-3 flex items-center gap-1.5 font-mono text-xs text-fg-faint" title={whereTitle}>
        {where}
      </span>
    </>
  );
  if (source === undefined) {
    return (
      <div data-tile={row.role} className={style}>
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-tile={row.role}
      onClick={() => onOpen(source)}
      className={cn(style, hover, "flex flex-col justify-start")}
    >
      {inner}
    </button>
  );
}

// Component and infra ---------------------------------------------------------------------

function Plain({ page, changed, onOpen }: Props) {
  const files = useMemo(() => sourcesOf(page), [page]);
  return (
    <>
      <DetailSection title={page.kind === "infra" ? "What it is" : "What it does"} className={FIRST}>
        <Text page={page} onOpen={onOpen} />
      </DetailSection>
      {files.length > 0 && (
        <DetailSection title="Where" note="Click a file to read it at the line.">
          <div className="flex flex-wrap gap-1.5">
            {files.map((s) => (
              <SourceChip
                key={`${s.path}:${s.lines[0]}-${s.lines[1]}`}
                source={s}
                moved={changed.has(s.path)}
                onOpen={onOpen}
              />
            ))}
          </div>
        </DetailSection>
      )}
      <Diagrams page={page} title="How it connects" height={380} />
      {page.claims.length > 0 && (
        <DetailSection title="What it rests on" note="Each sentence with the file behind it.">
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {page.claims.map((c) => (
              <ClaimRow key={c.n} claim={c} changed={changed} onOpen={onOpen} />
            ))}
          </ol>
        </DetailSection>
      )}
    </>
  );
}

function ClaimRow({
  claim,
  changed,
  onOpen,
  step,
}: {
  claim: WikiClaim;
  changed: ReadonlySet<string>;
  onOpen: OpenSource;
  /** The number in the circle, on a flow. */
  step?: number;
}) {
  return (
    <li className="flex min-w-0 items-start gap-3" data-claim={claim.n}>
      {step !== undefined && (
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full border font-mono text-[11px] text-fg",
            claim.proven ? "border-line-bright" : "border-dashed border-amber",
          )}
        >
          {step}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="m-0 text-body leading-[22px] text-fg text-pretty">{claim.text}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Sources claim={claim} changed={changed} onOpen={onOpen} />
          <BasisMark proven={claim.proven} className="ml-1" />
        </div>
      </div>
    </li>
  );
}

// Flow ------------------------------------------------------------------------------------

function Flow({ page, changed, onOpen }: Props) {
  const intro = page.body.trim() !== "";
  return (
    <>
      <Diagrams page={page} title="How it moves" height={420}>
        {intro && <Text page={page} onOpen={onOpen} />}
      </Diagrams>
      <DetailSection
        title="Steps"
        note="In plain words, each with the file behind it."
        className={page.diagrams.length === 0 && !intro ? FIRST : ""}
      >
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {page.claims.map((c, i) => (
            <ClaimRow key={c.n} claim={c} changed={changed} onOpen={onOpen} step={i + 1} />
          ))}
        </ol>
      </DetailSection>
    </>
  );
}

// Gaps ------------------------------------------------------------------------------------

function Gaps({ page, all, changed, onOpen, onGo }: Props) {
  const { guessed, dropped } = useMemo(() => openItems(all), [all]);
  const empty = guessed.length === 0 && dropped.length === 0 && page.body.trim() === "";
  return (
    <>
      <DetailSection
        title="Open items"
        note="Nothing here is hidden. Each item says what is missing."
        className={FIRST}
      >
        {empty ? (
          <p className="text-base text-fg-muted">Nothing to check.</p>
        ) : (
          <Text page={page} onOpen={onOpen} />
        )}
      </DetailSection>
      {guessed.length > 0 && (
        <DetailSection title="Guessed" note="A page says this, but no file shows it. Confirm it in the code.">
          <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
            {guessed.map(({ page: from, claim }) => (
              <li key={`${from.id}:${claim.n}`} className="flex min-w-0 flex-col gap-1.5">
                <p className="m-0 text-body text-fg text-pretty">{claim.text}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <BasisMark proven={false} />
                  <Sources claim={claim} changed={changed} onOpen={onOpen} />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    onClick={() => onGo(from.id)}
                  >
                    {from.title}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
      {dropped.length > 0 && (
        <DetailSection
          title="Could not confirm"
          note="The writer cited a place the code does not show. These left the pages."
        >
          <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
            {dropped.map((d) => (
              <li key={`${d.page.id}:${d.text}`} className="flex min-w-0 flex-col gap-1">
                <p className="m-0 text-body text-fg text-pretty">{d.text}</p>
                <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
                  <span>{DROP_WORDS[d.reason]}</span>
                  {d.cited.map((c) => (
                    <code key={`${c.path}:${c.lines[0]}`} className="font-mono text-xs text-fg-faint">
                      {c.path}:{c.lines[0]}
                    </code>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    onClick={() => onGo(d.page.id)}
                  >
                    {d.page.title}
                  </Button>
                </p>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
    </>
  );
}

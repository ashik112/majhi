import { useMemo } from "react";
import { FactRow } from "./claims";
import { COPY } from "./copy";
import { flowsUsing, sourcesOf, talksTo } from "./model";
import type { PageProps } from "./page-view";
import { BasisMark, Block, BodyText, Fold, SourceChip, Text } from "./parts";
import { TalkArrow } from "./talk-arrow";

/**
 * A component's page: what it is, its files, what it talks to (read from the lines of its own diagram, which
 * is not drawn here), the flows that touch its folder, and every claim behind the page, folded.
 */
export function ComponentBody({ page, all, changed, onOpen, onGo }: PageProps) {
  const files = useMemo(() => sourcesOf(page), [page]);
  const summaries = useMemo(() => all.map((l) => l.summary), [all]);
  const talks = useMemo(() => talksTo(page, summaries), [page, summaries]);
  const flows = useMemo(() => flowsUsing(page, all), [page, all]);
  const proven = page.claims.filter((c) => c.proven).length;
  return (
    <>
      <Block title={COPY.heading.about} first>
        <BodyText page={page} onOpen={onOpen} leadOnly />
      </Block>
      {files.length > 0 && (
        <Block title={COPY.heading.files}>
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
        </Block>
      )}
      {talks.length > 0 && (
        <Block title={COPY.heading.talksTo}>
          <ul className="m-0 flex list-none flex-col p-0">
            {talks.map((t) => (
              <li
                key={t.key}
                className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 py-1.5 text-base"
                data-talk=""
              >
                <TalkArrow type={t.type} guessed={!t.proven} reversed={t.incoming} />
                {t.other.page === undefined ? (
                  <span className="text-fg">{t.other.label}</span>
                ) : (
                  <PageLink id={t.other.page.id} onGo={onGo}>
                    {t.other.label}
                  </PageLink>
                )}
                {t.label !== undefined && <Text className="text-fg-muted">{t.label}</Text>}
                <BasisMark proven={t.proven} className="ml-auto" />
              </li>
            ))}
          </ul>
        </Block>
      )}
      {flows.length > 0 && (
        <Block title={COPY.heading.usedInFlows}>
          <div className="flex flex-wrap gap-1.5">
            {flows.map(({ summary }) => (
              <button
                key={summary.id}
                type="button"
                data-flow-chip={summary.id}
                onClick={() => onGo(summary.id)}
                className="inline-flex h-[26px] cursor-pointer items-center rounded-sm border border-line-strong px-2.5 text-sm text-fg-soft transition-colors duration-150 hover:border-line-hover hover:bg-raised hover:text-fg"
              >
                {summary.title}
              </button>
            ))}
          </div>
        </Block>
      )}
      {page.claims.length > 0 && (
        <Fold title={COPY.heading.details} note={COPY.details.count(proven, page.claims.length)}>
          <ul className="m-0 flex list-none flex-col p-0">
            {page.claims.map((c) => (
              <FactRow key={c.n} claim={c} changed={changed} onOpen={onOpen} />
            ))}
          </ul>
        </Fold>
      )}
    </>
  );
}

function PageLink({
  id,
  onGo,
  children,
}: {
  id: Parameters<PageProps["onGo"]>[0];
  onGo: PageProps["onGo"];
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onGo(id)}
      className="cursor-pointer text-blue hover:underline hover:underline-offset-2"
    >
      {children}
    </button>
  );
}

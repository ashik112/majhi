import { FactRow } from "./claims";
import { COPY } from "./copy";
import { unitName } from "./model";
import type { PageProps } from "./page-view";
import { Block, BodyText, Sources, Text } from "./parts";

/**
 * The infra page: what runs (the claims that rest on a unit or a store fact, named by that fact, with the
 * file that shows each) and how it is deployed (every other claim). The page has no field for hosts.
 */
export function InfraBody({ page, changed, onOpen }: PageProps) {
  const units = page.claims.filter((c) => unitName(c) !== undefined);
  const rest = page.claims.filter((c) => unitName(c) === undefined);
  return (
    <>
      <Block title={COPY.heading.about} first>
        <BodyText page={page} onOpen={onOpen} leadOnly />
      </Block>
      {units.length > 0 && (
        <Block title={COPY.heading.whatRuns}>
          <div className="flex flex-col overflow-hidden rounded-[10px] border border-line-strong">
            <div className="grid grid-cols-[130px_minmax(0,1fr)_auto] gap-3 border-b border-line px-3 py-1.5 text-[11px] font-medium tracking-[0.08em] text-fg-faint uppercase">
              <span>{COPY.table.unit}</span>
              <span>{COPY.table.how}</span>
              <span>{COPY.table.file}</span>
            </div>
            {units.map((c) => (
              <div
                key={c.n}
                data-unit={unitName(c)}
                className="grid grid-cols-[130px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3 py-2 text-base last:border-b-0"
              >
                <span className="min-w-0 truncate font-medium text-fg" title={unitName(c)}>
                  {unitName(c)}
                </span>
                <Text className="text-fg-muted">{c.text}</Text>
                <span className="flex items-center gap-1.5">
                  <Sources claim={c} changed={changed} onOpen={onOpen} />
                </span>
              </div>
            ))}
          </div>
        </Block>
      )}
      {rest.length > 0 && (
        <Block title={COPY.heading.deploy}>
          <ul className="m-0 flex list-none flex-col p-0">
            {rest.map((c) => (
              <FactRow key={c.n} claim={c} changed={changed} onOpen={onOpen} />
            ))}
          </ul>
        </Block>
      )}
    </>
  );
}

import { FactRow } from "./claims";
import { COPY } from "./copy";
import type { PageProps } from "./page-view";
import { BodyText, Fold } from "./parts";

/**
 * The Deploys page: the page's own text, in the short sections the writer gave it (where it deploys, parts, order,
 * guards, rollback, migrations, unusual, what was not found, and the owner's notes), with each `[n]` opening its file.
 * Every claim sits folded below with its files.
 */
export function DeploysBody({ page, changed, onOpen }: PageProps) {
  const proven = page.claims.filter((c) => c.proven).length;
  return (
    <>
      <div className="pt-4 pb-5">
        <BodyText page={page} onOpen={onOpen} />
      </div>
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

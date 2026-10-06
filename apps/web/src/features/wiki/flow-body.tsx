import type { DiagramNode } from "@majhi/shared";
import { StepRow } from "./claims";
import { COPY } from "./copy";
import { PageDiagrams } from "./diagrams";
import type { PageProps } from "./page-view";
import { Block } from "./parts";

const NO_PAGE = (_: DiagramNode): undefined => undefined;

/** A flow: the sequence of who calls whom, then its steps, each with its sentence and the files behind it. */
export function FlowBody({ page, changed, onOpen }: PageProps) {
  return (
    <>
      {page.diagrams.length > 0 && (
        <Block title={COPY.heading.sequence} first>
          <PageDiagrams specs={page.diagrams} pageOf={NO_PAGE} />
        </Block>
      )}
      <Block title={COPY.heading.steps} first={page.diagrams.length === 0}>
        <ol className="m-0 flex list-none flex-col p-0">
          {page.claims.map((c, i) => (
            <StepRow key={c.n} claim={c} step={i + 1} changed={changed} onOpen={onOpen} />
          ))}
        </ol>
      </Block>
    </>
  );
}

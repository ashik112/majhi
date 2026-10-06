import type { DiagramNode, DiagramSpec } from "@majhi/shared";
import { useCallback } from "react";
import type { NodeDecor } from "@/features/diagram/diagram-canvas";
import { DiagramItem } from "@/features/room/diagram-item";
import { COPY } from "./copy";

/**
 * The diagrams of a page, drawn bare (the section's heading names them). A click on a box opens the page
 * behind it, when there is one; a workspace's repo boxes carry an "Open its wiki" link too.
 */
export function PageDiagrams({
  specs,
  pageOf,
  withLinks = false,
}: {
  specs: readonly DiagramSpec[];
  /** What a box leads to, if anything. */
  pageOf: (node: DiagramNode) => (() => void) | undefined;
  /** Show the link under a box that leads somewhere. */
  withLinks?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {specs.map((spec) => (
        <OneDiagram key={spec.title} spec={spec} pageOf={pageOf} withLinks={withLinks} />
      ))}
    </div>
  );
}

function OneDiagram({
  spec,
  pageOf,
  withLinks,
}: {
  spec: DiagramSpec;
  pageOf: (node: DiagramNode) => (() => void) | undefined;
  withLinks: boolean;
}) {
  const decorate = useCallback(
    (n: DiagramNode): NodeDecor => {
      const go = pageOf(n);
      return withLinks && go !== undefined
        ? { action: { label: `${COPY.workspace.openWiki} →`, onClick: go } }
        : {};
    },
    [pageOf, withLinks],
  );
  const open = useCallback(
    (id: string) => {
      const node = spec.nodes.find((n) => n.id === id);
      if (node !== undefined) pageOf(node)?.();
    },
    [spec, pageOf],
  );
  return <DiagramItem spec={spec} bare fitMin={0.4} node={decorate} onOpenNode={open} />;
}

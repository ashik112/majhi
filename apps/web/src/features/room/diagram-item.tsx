import { type DiagramNode, type DiagramSpec, edgeKey } from "@majhi/shared";
import { Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { NodeDecor, Selection } from "@/features/diagram/diagram-canvas";
import { sequenceHeight } from "@/features/diagram/layouts/sequence";
import { LazyScene } from "@/features/diagram/lazy-scene";
import { type LegendKey, legendOf } from "@/features/diagram/presets";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/** True once the element has been on screen. A diagram further up or down the room is not drawn until then. */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          watch.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [seen]);
  return { ref, seen };
}

/** What a click shows under the diagram: the box's name and its sub line, or the line's label. */
function captionOf(spec: DiagramSpec, selection: Selection): string | undefined {
  if (selection?.kind === "node") {
    const n = spec.nodes.find((m) => m.id === selection.id);
    return n === undefined ? undefined : [n.label, n.sub].filter(Boolean).join(": ");
  }
  if (selection?.kind === "edge") {
    const i = spec.edges.findIndex((e, k) => edgeKey(e, k) === selection.id);
    const e = spec.edges[i];
    if (e === undefined) return undefined;
    const name = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;
    return `${name(e.from)} to ${name(e.to)}${e.label === undefined ? "" : `: ${e.label}`}`;
  }
  return undefined;
}

/**
 * A diagram, inline: the diagram canvas, drawn only once it scrolls into view. Click a box to read its sub
 * line; "Open full size" shows it large.
 *
 * In a room it is a glass card with the diagram's title and the agent that drew it, at a fixed height. A page
 * that names the diagram itself (the wiki) passes `bare`: no title, no zoom buttons, a frame as tall as the
 * drawing needs, the legend under it and "Open full size" in its corner.
 */
export function DiagramItem({
  spec,
  agent,
  height,
  legend,
  fitMin,
  bare = false,
  node,
  onOpenNode,
}: {
  spec: DiagramSpec;
  /** Who drew it. A wiki page's diagram has no author to name. */
  agent?: string;
  /** The frame's height. Default: 320, and for a sequence its own height up to 520, since it is never scaled down. */
  height?: number;
  legend?: readonly LegendKey[];
  /** The smallest zoom the first view may use; a wide diagram goes lower. */
  fitMin?: number;
  bare?: boolean;
  /** What a page adds to a box. */
  node?: (n: DiagramNode) => NodeDecor;
  /** A click on a box opens something (a page) instead of showing its sub line. */
  onOpenNode?: (id: string) => void;
}) {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const [selection, setSelection] = useState<Selection>();
  const [large, setLarge] = useState(false);
  const caption = captionOf(spec, selection);
  const diagram = useMemo(() => spec, [spec]);
  const frame =
    height ??
    (spec.layout === "sequence" ? Math.min(520, sequenceHeight(spec.edges.length, spec.nodes)) : 320);
  const select = useCallback(
    (next: Selection) => {
      if (next?.kind === "node" && onOpenNode !== undefined) {
        setLarge(false);
        onOpenNode(next.id);
        return;
      }
      setSelection(next);
    },
    [onOpenNode],
  );
  const marks = legend ?? (bare ? legendOf(spec) : undefined);
  const open = (
    <Button
      size="sm"
      variant="ghost"
      className={bare ? "h-6 gap-1 px-1.5 text-xs" : "ml-auto"}
      onClick={() => setLarge(true)}
    >
      <Maximize2 aria-hidden="true" className={bare ? "size-3" : undefined} />
      Open full size
    </Button>
  );
  const scene = (big: boolean) => (
    <LazyScene
      diagram={diagram}
      selection={selection}
      onSelect={select}
      legend={marks}
      fitMin={fitMin}
      node={node}
      {...(big ? {} : bare ? { autoHeight: true, controls: false, corner: open } : {})}
    />
  );
  return (
    <div ref={ref} className={cn(bare ? "" : "my-2 max-w-[860px]")} data-diagram-item="">
      <div className={cn("overflow-hidden rounded-xl", bare ? "border border-line-strong bg-sunken" : GLASS)}>
        {!bare && (
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
            <span className="min-w-0 truncate text-base font-medium text-fg">{spec.title}</span>
            {agent !== undefined && <span className="shrink-0 text-xs text-fg-faint">drawn by @{agent}</span>}
            {open}
          </div>
        )}
        <div style={bare ? undefined : { height: frame }}>
          {seen ? (
            scene(false)
          ) : (
            <div
              className="grid place-items-center text-sm text-fg-faint"
              style={{ height: bare ? Math.min(frame, 200) : "100%" }}
            >
              Drawing when it scrolls into view
            </div>
          )}
        </div>
        {caption !== undefined && (
          <p className="min-h-7 border-t border-line px-3 py-1 text-sm text-fg-muted" aria-live="polite">
            {caption}
          </p>
        )}
      </div>
      {large && (
        <Modal
          label={spec.title}
          onClose={() => setLarge(false)}
          className="h-[calc(100dvh-48px)] w-[calc(100vw-48px)] flex-col open:flex"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
            <h2 className="min-w-0 truncate text-md font-semibold text-fg">{spec.title}</h2>
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              aria-label="Close"
              onClick={() => setLarge(false)}
            >
              <X />
            </Button>
          </div>
          <div className="min-h-0 flex-1">{scene(true)}</div>
          {caption !== undefined && (
            <p className="min-h-8 shrink-0 border-t border-line px-4 py-1.5 text-sm text-fg-muted">
              {caption}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

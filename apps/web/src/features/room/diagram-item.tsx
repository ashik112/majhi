import { type DiagramSpec, edgeKey } from "@majhi/shared";
import { Maximize2, X } from "lucide-react";
import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { Selection } from "@/features/diagram/diagram-canvas";
import { LazyScene } from "@/features/diagram/lazy-scene";
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
 * A diagram an agent drew, inline in the room: the diagram canvas at a fixed height, drawn
 * only once it scrolls into view. Click a box to read its sub line; "Open full size" shows it large.
 */
export function DiagramItem({
  spec,
  agent,
  height = 320,
  legend,
  fitMin,
}: {
  spec: DiagramSpec;
  /** Who drew it. A wiki page's diagram has no author to name. */
  agent?: string;
  height?: number;
  legend?: ComponentProps<typeof LazyScene>["legend"];
  /** The smallest zoom the first view may use; a wide diagram goes lower. */
  fitMin?: number;
}) {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const [selection, setSelection] = useState<Selection>();
  const [large, setLarge] = useState(false);
  const caption = captionOf(spec, selection);
  const diagram = useMemo(() => spec, [spec]);
  return (
    <div ref={ref} className="my-2 max-w-[860px]" data-diagram-item="">
      <div className={cn("overflow-hidden rounded-xl", GLASS)}>
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="min-w-0 truncate text-base font-medium text-fg">{spec.title}</span>
          {agent !== undefined && <span className="shrink-0 text-xs text-fg-faint">drawn by @{agent}</span>}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setLarge(true)}>
            <Maximize2 aria-hidden="true" />
            Open full size
          </Button>
        </div>
        <div style={{ height }}>
          {seen ? (
            <LazyScene
              diagram={diagram}
              selection={selection}
              onSelect={setSelection}
              legend={legend}
              fitMin={fitMin}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-fg-faint">
              Drawing when it scrolls into view
            </div>
          )}
        </div>
        <p className="min-h-7 border-t border-line px-3 py-1 text-sm text-fg-muted" aria-live="polite">
          {caption ?? "Click a box to read more about it."}
        </p>
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
          <div className="min-h-0 flex-1">
            <LazyScene
              diagram={diagram}
              selection={selection}
              onSelect={setSelection}
              legend={legend}
              fitMin={fitMin}
            />
          </div>
          <p className="min-h-8 shrink-0 border-t border-line px-4 py-1.5 text-sm text-fg-muted">
            {caption ?? "Click a box to read more about it."}
          </p>
        </Modal>
      )}
    </div>
  );
}

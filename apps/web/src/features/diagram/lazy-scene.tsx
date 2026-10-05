import { lazy, Suspense } from "react";
import type { DiagramCanvasProps } from "./diagram-canvas";

/**
 * The graph library, the layout engine and the canvas load only when a page first shows a diagram (a code
 * split): every other page pays nothing for them.
 */
const load = () => import("./scene");
const Scene = lazy(load);

/** Starts fetching the canvas now, so it is there when the data is: a page calls it on mount. */
export function preloadScene(): void {
  void load();
}

export function LazyScene(props: Omit<DiagramCanvasProps, "positioned">) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-busy="true" className="grid h-full place-items-center text-sm text-fg-faint">
          Drawing
        </div>
      }
    >
      <Scene {...props} />
    </Suspense>
  );
}

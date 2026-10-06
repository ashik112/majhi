import { useMemo } from "react";
import { DiagramCanvas, type DiagramCanvasProps } from "./diagram-canvas";
import { usePositioned } from "./use-positioned";

/** A diagram laid out and drawn. The one thing the pages import, always through `lazy-scene.tsx`. */
export default function DiagramScene(props: Omit<DiagramCanvasProps, "positioned">) {
  const { diagram, node } = props;
  const action = useMemo(
    () => new Set(diagram.nodes.filter((n) => node?.(n).action !== undefined).map((n) => n.id)),
    [diagram, node],
  );
  const positioned = usePositioned(diagram, action);
  if (positioned === undefined) {
    return (
      <div role="status" aria-busy="true" className="grid h-full place-items-center text-sm text-fg-faint">
        Drawing
      </div>
    );
  }
  return <DiagramCanvas {...props} positioned={positioned} />;
}

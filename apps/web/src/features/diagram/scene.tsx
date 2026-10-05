import { DiagramCanvas, type DiagramCanvasProps } from "./diagram-canvas";
import { usePositioned } from "./use-positioned";

/** A diagram laid out and drawn. The one thing the pages import, always through `lazy-scene.tsx`. */
export default function DiagramScene(props: Omit<DiagramCanvasProps, "positioned">) {
  const positioned = usePositioned(props.diagram);
  return <DiagramCanvas {...props} positioned={positioned} />;
}

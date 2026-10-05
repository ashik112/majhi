import { lazy, Suspense } from "react";
import type { TaskFiles } from "./media";
import type { MarkdownSize } from "./markdown-view";

export { CopyButton } from "./copy-button";
export type { MarkdownSize } from "./markdown-view";

/** The renderer (react-markdown, remark, highlighting) loads when the first message is shown, not with the app. */
const MarkdownView = lazy(() => import("./markdown-view").then((m) => ({ default: m.Markdown })));

/** Agent text as React elements; see `markdown-view.tsx`. Plain text shows until the renderer is there. */
export function Markdown(props: {
  text: string;
  task?: TaskFiles | undefined;
  /** Folder of the document being shown, relative to the task folder, for relative links. */
  baseDir?: string;
  size?: MarkdownSize;
}) {
  return (
    <Suspense fallback={<div className="md whitespace-pre-wrap">{props.text}</div>}>
      <MarkdownView {...props} />
    </Suspense>
  );
}

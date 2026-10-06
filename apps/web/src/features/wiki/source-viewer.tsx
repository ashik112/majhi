import type { WikiSource } from "@majhi/shared";
import { lazy, Suspense } from "react";
import { Modal } from "@/components/ui/modal";

/** The file viewer loads when a source is first opened, as it does from a task. */
const Viewer = lazy(() => import("@/features/viewer/file-viewer").then((m) => ({ default: m.Viewer })));

/**
 * A wiki source in the file viewer: the file of the project's export at the commit the page was built
 * from, with the cited lines tinted and scrolled to. Read only, and it belongs to no task.
 */
export function SourceViewer({
  org,
  project,
  source,
  moved,
  onClose,
}: {
  org: string;
  project: string;
  source: WikiSource;
  /** A newer commit changed this file. */
  moved: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      label={`File ${source.path}`}
      onClose={onClose}
      className="fixed top-3 right-3 bottom-3 left-auto m-0 h-[calc(100dvh-24px)] max-h-none w-[60vw] min-w-[min(560px,100vw)] max-w-[calc(100vw-24px)] flex-col open:flex rounded-2xl"
    >
      <Suspense
        fallback={
          <div role="status" aria-busy="true" className="p-6 text-base text-fg-faint">
            Opening {source.path}
          </div>
        }
      >
        <Viewer
          key={`${source.path}:${source.lines[0]}`}
          taskId=""
          folder=""
          fileRef={{ kind: "wiki", org, project, commit: source.commit, path: source.path }}
          items={[]}
          repos={[]}
          cite={{ lines: source.lines, commit: source.commit, changed: moved }}
          onClose={onClose}
        />
      </Suspense>
    </Modal>
  );
}

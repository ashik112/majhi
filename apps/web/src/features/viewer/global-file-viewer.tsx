import { useSearch } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTask } from "@/lib/task-queries";

const FileViewer = lazy(() => import("./file-viewer").then((m) => ({ default: m.FileViewer })));

/** The file viewer on any page: a file link in any room opens it over the page the owner is on. */
export function GlobalFileViewer() {
  const { file, fileTask } = useSearch({ from: "__root__" });
  const task = useTask(file === undefined ? undefined : fileTask);
  if (file === undefined || fileTask === undefined || task.data === undefined) return null;
  return (
    <Suspense fallback={null}>
      <FileViewer
        taskId={task.data.id}
        folder={task.data.folder}
        path={file}
        items={[]}
        repos={task.data.repos}
      />
    </Suspense>
  );
}

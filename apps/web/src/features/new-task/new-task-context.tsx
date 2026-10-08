import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

const NewTaskDialog = lazy(() =>
  import("./new-task-dialog").then((module) => ({ default: module.NewTaskDialog })),
);

interface NewTaskApi {
  open: () => void;
  /** Opens the dialog with this project already picked. */
  openFor: (project: string, title?: string) => void;
}

const NewTaskContext = createContext<NewTaskApi | null>(null);

/** Opens the New task dialog from anywhere: the sidebar, the board, the `n` key, a box on the map. */
export function useNewTask(): NewTaskApi {
  const api = useContext(NewTaskContext);
  if (!api) throw new Error("useNewTask needs a <NewTaskProvider> above it");
  return api;
}

export function NewTaskProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<{ project?: string; title?: string } | undefined>();
  const open = useCallback(() => setDialog({}), []);
  const openFor = useCallback(
    (project: string, title?: string) => setDialog({ project, ...(title === undefined ? {} : { title }) }),
    [],
  );
  const api = useMemo(() => ({ open, openFor }), [open, openFor]);
  return (
    <NewTaskContext.Provider value={api}>
      {children}
      {dialog !== undefined && (
        <Suspense
          fallback={
            <span role="status" className="sr-only">
              Loading new task
            </span>
          }
        >
          <NewTaskDialog
            {...(dialog.project === undefined ? {} : { project: dialog.project })}
            {...(dialog.title === undefined ? {} : { title: dialog.title })}
            onClose={() => setDialog(undefined)}
          />
        </Suspense>
      )}
    </NewTaskContext.Provider>
  );
}

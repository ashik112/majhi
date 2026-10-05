import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { NewTaskDialog } from "./new-task-dialog";

interface NewTaskApi {
  open: () => void;
  /** Opens the dialog with this project already picked. */
  openFor: (project: string) => void;
}

const NewTaskContext = createContext<NewTaskApi | null>(null);

/** Opens the New task dialog from anywhere: the sidebar, the board, the `n` key, a box on the map. */
export function useNewTask(): NewTaskApi {
  const api = useContext(NewTaskContext);
  if (!api) throw new Error("useNewTask needs a <NewTaskProvider> above it");
  return api;
}

export function NewTaskProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<{ project?: string } | undefined>();
  const open = useCallback(() => setDialog({}), []);
  const openFor = useCallback((project: string) => setDialog({ project }), []);
  const api = useMemo(() => ({ open, openFor }), [open, openFor]);
  return (
    <NewTaskContext.Provider value={api}>
      {children}
      {dialog !== undefined && (
        <NewTaskDialog
          {...(dialog.project === undefined ? {} : { project: dialog.project })}
          onClose={() => setDialog(undefined)}
        />
      )}
    </NewTaskContext.Provider>
  );
}

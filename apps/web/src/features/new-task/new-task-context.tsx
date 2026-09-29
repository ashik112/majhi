import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { NewTaskDialog } from "./new-task-dialog";

interface NewTaskApi {
  open: () => void;
}

const NewTaskContext = createContext<NewTaskApi | null>(null);

/** Opens the New task dialog from anywhere: the sidebar, the board, the `n` key. */
export function useNewTask(): NewTaskApi {
  const api = useContext(NewTaskContext);
  if (!api) throw new Error("useNewTask needs a <NewTaskProvider> above it");
  return api;
}

export function NewTaskProvider({ children }: { children: ReactNode }) {
  const [openDialog, setOpenDialog] = useState(false);
  const open = useCallback(() => setOpenDialog(true), []);
  const api = useMemo(() => ({ open }), [open]);
  return (
    <NewTaskContext.Provider value={api}>
      {children}
      {openDialog && <NewTaskDialog onClose={() => setOpenDialog(false)} />}
    </NewTaskContext.Provider>
  );
}

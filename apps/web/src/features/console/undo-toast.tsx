import { undoLast, useUndoToast } from "./actions";
import { Kbd } from "./parts";

/** The line that follows every action for five seconds, with the way back. Mounted once, in the shell. */
export function UndoToast() {
  const toast = useUndoToast();
  return (
    <div className="cs-toast" role="status" aria-live="polite" data-on={toast !== undefined}>
      <span>{toast?.text ?? ""}</span>
      <button type="button" className="cs-btn" onClick={() => undoLast()} tabIndex={toast === undefined ? -1 : 0}>
        Undo <Kbd>U</Kbd>
      </button>
    </div>
  );
}

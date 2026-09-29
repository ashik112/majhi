import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * A modal on the native `<dialog>`: the browser traps focus, makes the page behind inert and
 * restores focus on close. Esc asks to close; the parent decides by unmounting or not.
 */
export function Modal({
  label,
  onClose,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const previous = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    previous.current = document.activeElement;
    if (!dialog.open) dialog.showModal();
    return () => {
      dialog.close();
      if (previous.current instanceof HTMLElement && previous.current.isConnected) previous.current.focus();
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop click is a mouse shortcut; Esc closes from the keyboard
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "m-auto max-h-[calc(100dvh-32px)] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-line-bright bg-panel p-0 text-fg shadow-pop",
        "backdrop:bg-sunken/70",
        className,
      )}
    >
      {children}
    </dialog>
  );
}

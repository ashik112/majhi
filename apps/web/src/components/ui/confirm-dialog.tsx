import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

/** A small yes or no modal. `error` shows the server's refusal and keeps the dialog open. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  confirmDisabled,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  /** Keeps the confirm button off until the dialog's own check passes, like a typed name. */
  confirmDisabled?: boolean;
  error?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal label={title} onClose={onCancel} className="w-[440px]">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-md font-semibold">{title}</h2>
        <div className="text-base text-fg-muted text-pretty">{body}</div>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-base text-red text-pretty"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy === true || confirmDisabled === true}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

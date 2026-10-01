import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

/** The frame of the schedule and trigger forms: a title, a body that scrolls, a problem line and Save. */
export function FormShell({
  title,
  saveLabel,
  busy,
  problem,
  onSave,
  onClose,
  children,
}: {
  title: string;
  saveLabel: string;
  busy: boolean;
  problem: string | undefined;
  onSave: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal label={title} onClose={onClose} className="flex w-[680px] flex-col open:flex">
      <form
        className="flex max-h-[calc(100dvh-32px)] min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <h2 className="shrink-0 border-b border-line-strong px-5 py-3.5 text-md font-semibold">{title}</h2>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4 scroll-fade">
          {children}
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-line-strong px-5 py-3">
          {problem && (
            <p role="alert" className="min-w-0 flex-1 text-sm text-red text-pretty">
              {problem}
            </p>
          )}
          <div className="ml-auto flex shrink-0 gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {saveLabel}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** A group of fields under a small title, divided from the one before by a hairline. */
export function FormGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0"
    >
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

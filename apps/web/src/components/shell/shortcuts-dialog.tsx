import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Modal } from "@/components/ui/modal";
import { SHORTCUTS } from "@/features/shell/shortcuts";

/** The list behind `?`. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="Keyboard shortcuts" onClose={onClose} className="w-[420px]">
      <div className="flex flex-col gap-4 p-[22px]">
        <div className="flex items-center">
          <h2 className="text-[18px] font-semibold">Keyboard shortcuts</h2>
          <Button variant="ghost" size="icon" className="ml-auto -mr-2" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <dl className="flex flex-col gap-2.5">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center gap-3 text-base">
              <dt className="flex w-24 shrink-0 gap-1">
                {s.keys === "Enter" || s.keys === "Esc" || s.keys === "?" || s.keys === "n" ? (
                  <Kbd>{s.keys}</Kbd>
                ) : (
                  s.keys.split(" ").map((k) => <Kbd key={k}>{k}</Kbd>)
                )}
              </dt>
              <dd className="text-fg-soft">{s.what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}

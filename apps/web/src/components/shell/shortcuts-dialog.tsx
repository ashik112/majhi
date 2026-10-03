import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Modal } from "@/components/ui/modal";
import { SHORTCUT_TABLE, type ShortcutDef, type ShortcutGroup } from "@/features/shell/shortcuts";
import { MOD_KEY } from "@/lib/format";

const GROUPS: readonly ShortcutGroup[] = ["Anywhere", "Task", "Message box", "Board", "Decisions", "Go to"];

/** The `g` row only explains the chord; the pages below it carry the letters. */
function listed(group: ShortcutGroup): ShortcutDef[] {
  return SHORTCUT_TABLE.filter((s) => s.group === group);
}

/** The list behind `?`, printed from the shortcut table the handlers read. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="Keyboard shortcuts" onClose={onClose} className="w-[520px]">
      <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-[22px]">
        <div className="flex items-center">
          <h2 className="text-[18px] font-semibold">Keyboard shortcuts</h2>
          <Button variant="ghost" size="icon" className="ml-auto -mr-2" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {GROUPS.map((group) => (
          <section key={group} aria-label={group} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-fg-faint uppercase">{group}</h3>
            <dl className="m-0 flex flex-col gap-2">
              {listed(group).map((s) => (
                <div key={s.id} className="flex items-center gap-3 text-base">
                  <dt className="flex w-28 shrink-0 gap-1">
                    {s.keys.map((k, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the caps of one shortcut never reorder
                      <Kbd key={i}>{k === "Mod" ? MOD_KEY : k}</Kbd>
                    ))}
                  </dt>
                  <dd className="m-0 text-fg-soft">{s.what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="m-0 text-xs text-fg-faint">
          Keys other than {MOD_KEY} K, {MOD_KEY} J and {MOD_KEY} Enter do nothing while you type in a field.
        </p>
      </div>
    </Modal>
  );
}

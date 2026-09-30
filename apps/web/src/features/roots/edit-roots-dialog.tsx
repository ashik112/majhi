import type { WorkspacesUpdateResult } from "@majhi/shared";
import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { useConfig } from "@/lib/queries";
import { draftFromConfig } from "./model";
import { RestartCard } from "./restart-card";
import { RestartingCard } from "./restarting-card";
import { RootsForm } from "./roots-form";

/**
 * The roots form in a dialog, for the pages that show the roots. A save that needs a restart goes
 * on to the same restart cards as onboarding, inside the dialog.
 */
export function EditRootsDialog({ onClose }: { onClose: () => void }) {
  const state = useConfig().data;
  const toast = useToast();
  const [pending, setPending] = useState<WorkspacesUpdateResult | null>(null);
  if (state?.status !== "loaded") return null;

  return (
    <Modal
      label="Workspace roots"
      onClose={onClose}
      className="max-h-[calc(100dvh-32px)] w-[640px] overflow-auto border-0 bg-transparent shadow-none backdrop-blur-none"
    >
      <div className="flex flex-col gap-4 p-1">
        {pending?.remount === "restarting" ? (
          <RestartingCard
            roots={pending.unmounted}
            home={pending.state.home}
            continueLabel="Close"
            onBack={() => {
              toast("Roots mounted");
              onClose();
            }}
            onContinue={onClose}
          />
        ) : pending ? (
          <RestartCard
            result={pending}
            home={pending.state.home}
            continueLabel="Close"
            onContinue={onClose}
          />
        ) : (
          <RootsForm
            mode="edit"
            home={state.home}
            file={state.file}
            initial={draftFromConfig(state.config, state.home)}
            onSaved={(result) => {
              if (result.remount !== "not-needed") return setPending(result);
              toast("Roots saved");
              onClose();
            }}
            onCancel={onClose}
          />
        )}
      </div>
    </Modal>
  );
}

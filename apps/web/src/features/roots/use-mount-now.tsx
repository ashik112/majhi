import { RESTART_COMMAND } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { reloadAfterRestart, useHostStatus, useRemount } from "@/lib/queries";
import { RestartingCard } from "./restarting-card";

/**
 * Mounts the workspace roots majhi cannot see, through the host helper (SPEC 3.5). `modal` shows
 * the restart progress and must be rendered by the caller.
 */
export function useMountNow(home: string): {
  canMount: boolean;
  mountNow: () => void;
  pending: boolean;
  modal: ReactNode;
} {
  const host = useHostStatus();
  const remount = useRemount();
  const client = useQueryClient();
  const toast = useToast();
  const [restarting, setRestarting] = useState<readonly string[] | null>(null);
  const canMount = host.data?.connected === true && host.data.info?.canRemount === true;

  function mountNow() {
    if (remount.isPending) return;
    remount.mutate(undefined, {
      onSuccess: (result) => {
        if (result.remount === "restarting") setRestarting(result.unmounted);
        else if (result.remount === "manual")
          toast("majhi cannot remount on its own", {
            detail: `Run ${RESTART_COMMAND} on your machine`,
            tone: "error",
          });
        else void reloadAfterRestart(client).then(() => toast("Already mounted"));
      },
      onError: (error) => toast("Could not mount", { detail: error.message, tone: "error" }),
    });
  }

  const modal = restarting ? (
    <Modal
      label="Mounting workspace roots"
      onClose={() => setRestarting(null)}
      className="w-[640px] border-0 bg-transparent shadow-none"
    >
      <div className="p-1">
        <RestartingCard
          roots={restarting}
          home={home}
          continueLabel="Close"
          onBack={() => {
            setRestarting(null);
            toast("Roots mounted");
          }}
          onContinue={() => setRestarting(null)}
        />
      </div>
    </Modal>
  ) : null;

  return { canMount, mountNow, pending: remount.isPending, modal };
}

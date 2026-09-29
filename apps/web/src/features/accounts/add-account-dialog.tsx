import { Modal } from "@/components/ui/modal";
import { AddAccountPanel } from "./accounts-view";

/** The add-account flow in a dialog, with an org preselected. */
export function AddAccountDialog({ org, onClose }: { org: string; onClose: () => void }) {
  return (
    <Modal label="Add an account" onClose={onClose} className="w-[440px]">
      <div className="max-h-[calc(100dvh-64px)] overflow-auto">
        <AddAccountPanel defaultOrg={org} onClose={onClose} onDone={onClose} />
      </div>
    </Modal>
  );
}

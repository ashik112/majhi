import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { PageLink } from "@/components/ui/page-link";
import { AddAccountFlow } from "./add-account-flow";

/** The add-account flow in a dialog, with an org preselected. */
export function AddAccountDialog({ org, onClose }: { org: string; onClose: () => void }) {
  return (
    <Modal label="Add an account" onClose={onClose} className="w-[440px]">
      <div className="max-h-[calc(100dvh-64px)] overflow-auto">
        <aside aria-label="Add an account" className="flex h-full flex-col gap-4 overflow-auto p-5">
          <div className="flex items-center">
            <h2 className="text-md font-semibold">Add an account</h2>
            <Button
              className="ml-auto"
              variant="ghost"
              size="icon-sm"
              aria-label="Close add account"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <AddAccountFlow
            defaultOrg={org}
            renderDone={(accountId, addAnother) => (
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="primary">
                  <PageLink page="agents" search={{ account: accountId }} onClick={onClose}>
                    Create an agent on this account
                  </PageLink>
                </Button>
                <Button onClick={addAnother}>Add another account</Button>
              </div>
            )}
          />
        </aside>
      </div>
    </Modal>
  );
}

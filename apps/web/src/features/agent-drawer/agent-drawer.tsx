import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { AgentDetails } from "@/features/task/agent-row";
import { useAgentIndex } from "@/lib/agent-index";
import { useAccounts } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import type { AppSearch } from "@/router";

/** An agent's details in a drawer over any page, opened by `?peek=<id>` from a mention in a message. */
export function AgentDrawer({ id }: { id: string }) {
  const navigate = useNavigate();
  const info = useAgentIndex().get(id);
  const account = useAccounts().data?.find((a) => a.id === info?.account);
  const now = useNow(30_000);
  const close = () =>
    navigate({
      to: ".",
      search: (prev: AppSearch) => {
        const { peek: _open, ...rest } = prev;
        return rest;
      },
    });
  return (
    <Modal
      label={`Agent @${id}`}
      onClose={close}
      className="fixed top-3 right-3 bottom-3 left-auto m-0 h-[calc(100dvh-24px)] max-h-none w-[min(420px,100vw)] max-w-[calc(100vw-24px)] flex-col open:flex rounded-2xl"
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-line-strong px-5 py-3">
        <AgentAvatar id={id} size={28} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-base font-semibold">@{id}</span>
          {info && (
            <span className="truncate text-xs text-fg-faint">
              {info.role} · {info.scope === "root" ? "root agent" : info.scope}
            </span>
          )}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Close agent details" onClick={close}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {info ? (
          <AgentDetails
            id={`peek-${id}`}
            agent={id}
            live={undefined}
            info={info}
            account={account}
            now={now}
          />
        ) : (
          <p className="text-sm text-fg-faint">No agent @{id}.</p>
        )}
      </div>
    </Modal>
  );
}

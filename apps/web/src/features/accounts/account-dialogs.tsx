import type { AccountView, ToolInfo } from "@majhi/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { describeError } from "@/lib/errors";
import { useAccountHealth, useRemoveAccount, useStartLogin } from "@/lib/studio-queries";
import { AccountProgress, type ProgressStage } from "./add-account-flow";
import { HealthDialog } from "./health-dialog";

export function HealthAccountDialog({ account, onClose }: { account: AccountView; onClose: () => void }) {
  const check = useAccountHealth();
  return (
    <HealthDialog
      title={`Health check: ${account.id}`}
      run={async () => (await check.mutateAsync(account.id)).health}
      onClose={onClose}
    />
  );
}

export function RemoveAccountDialog({ account, onClose }: { account: AccountView; onClose: () => void }) {
  const remove = useRemoveAccount();
  return (
    <ConfirmDialog
      title={`Remove ${account.id}?`}
      body="This deletes the account's config home on this machine. You will need to sign in again to use it later."
      confirmLabel="Remove account"
      busy={remove.isPending}
      error={remove.isError ? describeError(remove.error) : undefined}
      onCancel={onClose}
      onConfirm={() => remove.mutate(account.id, { onSuccess: onClose })}
    />
  );
}

export function SignInAgainDialog({
  account,
  tool,
  onClose,
}: {
  account: AccountView;
  tool: ToolInfo | undefined;
  onClose: () => void;
}) {
  const login = useStartLogin();
  const [stage, setStage] = useState<ProgressStage>({ kind: "checking", accountId: account.id });
  const hint = tool?.loginHint ?? "";

  // Start once on open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a single run per open; the mutation object changes every render
  useEffect(() => {
    let live = true;
    login.mutateAsync(account.id).then(
      (started) =>
        live &&
        setStage({
          kind: "login",
          accountId: account.id,
          loginHint: hint,
          terminalId: started.terminalId,
          command: started.command,
          state: { phase: "running" },
        }),
      (error) =>
        live &&
        setStage({
          kind: "stuck",
          accountId: account.id,
          mode: "login",
          loginHint: hint,
          message: describeError(error),
        }),
    );
    return () => {
      live = false;
    };
  }, [account.id]);

  const signedIn = stage.kind === "login" && stage.state.phase === "signed-in";
  const ok = signedIn || (stage.kind === "result" && stage.health.ok);

  return (
    <Modal label={`Sign in again: ${account.id}`} onClose={onClose} className="w-[560px]">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-md font-semibold">Sign in again: {account.id}</h2>
        {ok ? (
          <p role="status" className="text-base text-green">
            Signed in and healthy.
          </p>
        ) : (
          <AccountProgress stage={stage} setStage={setStage} />
        )}
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            {ok ? "Done" : "Close"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

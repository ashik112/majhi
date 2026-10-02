import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/ui/status-dot";
import { AddAccountFlow } from "@/features/accounts/add-account-flow";
import { isUsableStatus, statusInfo } from "@/features/accounts/model";
import { useAccounts } from "@/lib/studio-queries";
import { StepFrame, useStep } from "./step-frame";

/**
 * AI account: the first Claude Code or Codex login, through the same flow as the Accounts page
 * (an embedded terminal or a pasted API key). Done once an account passes its health check.
 */
export function AccountStep() {
  const step = useStep();
  const loaded = useAccounts().data;
  const healthy = (loaded ?? []).filter((a) => isUsableStatus(a.status));
  // Decided once, when the accounts first load: the add form stays open through its own sign-in.
  const [startedEmpty, setStartedEmpty] = useState<boolean>();
  useEffect(() => {
    if (loaded && startedEmpty === undefined) setStartedEmpty(!loaded.some((a) => isUsableStatus(a.status)));
  }, [loaded, startedEmpty]);
  const [addPick, setAdding] = useState<boolean>();
  const adding = addPick ?? startedEmpty ?? false;
  const [signedIn, setSignedIn] = useState(false);
  const ready = step.done || signedIn || healthy.length > 0;

  return (
    <StepFrame
      primary={
        ready ? (
          <Button variant="primary" size="lg" onClick={step.next}>
            Continue
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        {healthy.length > 0 && !adding && (
          <ul aria-label="Signed-in accounts" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {healthy.map((a) => (
              <li
                key={a.id}
                className="flex min-h-12 items-center gap-3 rounded-lg border border-line-strong bg-card px-3.5"
              >
                <Dot tone="green" size={7} />
                <span className="min-w-0 truncate font-mono text-base text-fg">{a.id}</span>
                {a.signedInAs && (
                  <span className="min-w-0 truncate text-sm text-fg-faint">{a.signedInAs}</span>
                )}
                <span className="ml-auto shrink-0 text-sm text-green">{statusInfo(a.status).label}</span>
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <div className="rounded-xl border border-line-strong bg-card p-5">
            <AddAccountFlow onHealthy={() => setSignedIn(true)} renderDone={() => null} />
          </div>
        ) : (
          <div>
            <Button variant="ghost" size="sm" className="-ml-2.5" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              Add another account
            </Button>
          </div>
        )}
      </div>
    </StepFrame>
  );
}

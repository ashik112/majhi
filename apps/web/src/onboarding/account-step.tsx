import { Button } from "@/components/ui/button";
import { AddAccountFlow } from "@/features/accounts/add-account-flow";
import type { OnboardingStepProps } from "./steps";

/** Step 2: add the first account. Done when it passes its health check. */
export function AccountStep({ isLast, onComplete, onSkip }: OnboardingStepProps) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-balance">Add your first account</h1>
        <p className="text-base text-fg-muted text-pretty">
          An account is one login for Claude Code or Codex, for your own use or for an org. Sign in with the
          tool's own login, or paste an API key.
        </p>
      </div>
      <div className="rounded-xl border border-line-strong bg-panel p-5">
        <AddAccountFlow
          renderDone={() => (
            <div>
              <Button variant="primary" onClick={onComplete}>
                {isLast ? "Finish" : "Continue"}
              </Button>
            </div>
          )}
        />
      </div>
      {onSkip && (
        <div>
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      )}
    </>
  );
}

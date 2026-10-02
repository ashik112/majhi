import type { MrHost, OnboardingWorkspace, SignInStart, SignInStatus } from "@majhi/shared";
import { CircleCheck, TriangleAlert } from "lucide-react";
import * as m from "motion/react-m";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { HOST_LABEL } from "@/lib/hosts";
import { useSignInCancel, useSignInConfirm, useSignInPoll, useSignInStart } from "@/lib/onboarding-queries";
import { useNow } from "@/lib/use-now";
import { CopyButton, countdown, ExternalButton, Waiting } from "../bits";
import { Problem } from "../step-frame";
import { AppSetup } from "./app-setup";

type Phase =
  | { kind: "starting" }
  | { kind: "needs-app"; start: Extract<SignInStart, { state: "needs-app" }> }
  | { kind: "flow"; start: Exclude<SignInStart, { state: "needs-app" }> }
  | { kind: "error"; message: string };

const ENDED_WORDS: Record<"denied" | "expired" | "cancelled", string> = {
  denied: "was refused on the host's page. Nothing was saved.",
  expired: "ran out of time before it finished. Nothing was saved.",
  cancelled: "was stopped. Nothing was saved.",
};

/**
 * Signing one workspace in to one git host, inline in the git step: the one-time app setup when the
 * host needs it, then the device code or the authorize page, a live wait, and who it works as.
 */
export function SignIn({
  workspace,
  kind,
  names,
  onClose,
}: {
  workspace: OnboardingWorkspace;
  kind: MrHost;
  /** Workspace names by id, for the reused-account warning. */
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const start = useSignInStart();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const label = HOST_LABEL[kind];

  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once per attempt
  useEffect(() => {
    setPhase({ kind: "starting" });
    start.mutate(
      { org: workspace.id, kind },
      {
        onSuccess: (s) =>
          setPhase(s.state === "needs-app" ? { kind: "needs-app", start: s } : { kind: "flow", start: s }),
        onError: (e) => setPhase({ kind: "error", message: describeError(e) }),
      },
    );
  }, [attempt, workspace.id, kind]);

  const again = () => setAttempt((n) => n + 1);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  return (
    <m.div
      ref={box}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col gap-4 rounded-xl border border-line-strong bg-sunken p-5"
    >
      {phase.kind === "starting" && <Waiting>Asking {label} for a sign-in code</Waiting>}
      {phase.kind === "error" && (
        <>
          <Problem>{phase.message}</Problem>
          <div className="flex gap-2">
            <Button onClick={again}>Try again</Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      )}
      {phase.kind === "needs-app" && <AppSetup setup={phase.start.setup} onSaved={again} />}
      {phase.kind === "flow" && (
        <Flow start={phase.start} workspace={workspace} names={names} onAgain={again} onClose={onClose} />
      )}
    </m.div>
  );
}

function Flow({
  start,
  workspace,
  names,
  onAgain,
  onClose,
}: {
  start: Exclude<SignInStart, { state: "needs-app" }>;
  workspace: OnboardingWorkspace;
  names: ReadonlyMap<string, string>;
  onAgain: () => void;
  onClose: () => void;
}) {
  const poll = useSignInPoll(start.signIn);
  const cancel = useSignInCancel();
  const status: SignInStatus | undefined = poll.data;
  const label = HOST_LABEL[start.kind];

  if (status?.state === "done") {
    return <Done status={status} workspace={workspace} names={names} onClose={onClose} />;
  }
  if (status?.state === "confirm") {
    return <Confirm status={status} workspace={workspace} names={names} onClose={onClose} />;
  }
  if (status && status.state !== "pending") {
    const words =
      status.state === "failed" ? status.reason : `The ${label} sign-in ${ENDED_WORDS[status.state]}`;
    return (
      <div className="flex flex-col gap-3">
        <Problem>{words}</Problem>
        <div className="flex gap-2">
          <Button variant="primary" onClick={onAgain}>
            Start again
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const page =
    start.state === "device" ? (start.verificationUriComplete ?? start.verificationUri) : start.authorizeUrl;
  return (
    <div className="flex flex-col gap-5">
      {start.state === "device" ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-base text-fg-soft">
            Enter this code on {label}. It proves the sign-in came from you.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <output
              aria-label="Sign-in code"
              className="flex h-16 items-center rounded-xl border border-accent-line bg-field px-6 font-mono text-[2rem] leading-none font-medium tracking-[0.16em] text-fg tabular-nums"
            >
              {start.userCode}
            </output>
            <CopyButton value={start.userCode} label="Copy the code" size="lg" />
          </div>
        </div>
      ) : (
        <p className="m-0 text-base text-fg-soft text-pretty">
          Allow majhi on {label}'s page. {label} then sends you back here and the sign-in ends by itself.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ExternalButton href={page} variant="primary" size="lg">
          Open {label}
        </ExternalButton>
        <span className="text-sm text-fg-faint">
          {start.opened ? "Opened in your browser. Open it again if you closed it." : "Opens in a new tab."}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4">
        <Waiting>Waiting for {label}</Waiting>
        <Expiry until={start.expiresAt} />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(start.signIn, { onSettled: onClose })}
        >
          Cancel
        </Button>
      </div>
      {poll.error && <Problem>{describeError(poll.error)}</Problem>}
    </div>
  );
}

function Expiry({ until, label = "Code works for" }: { until: string; label?: string }) {
  const now = useNow(1000);
  return (
    <span className="font-mono text-sm text-fg-faint tabular-nums">
      <span className="font-sans">{label} </span>
      {countdown(until, now)}
    </span>
  );
}

/** "Works as @user". Closes by itself after a moment; the workspace row keeps the account. */
function Done({
  status,
  workspace,
  names,
  onClose,
}: {
  status: Extract<SignInStatus, { state: "done" }>;
  workspace: OnboardingWorkspace;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const label = HOST_LABEL[status.kind];
  const others = status.alsoUsedBy.map((id) => names.get(id) ?? id);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const timer = window.setTimeout(() => close.current(), 2400);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="m-0 flex items-center gap-2.5 text-md text-fg">
        <CircleCheck aria-hidden="true" className="size-[18px] text-green" />
        <span>
          Works as <span className="font-mono font-medium">@{status.account}</span> on {label}
        </span>
      </p>
      {status.replaced && (
        <p className="m-0 pl-[28px] text-sm text-fg-muted">
          This replaces <span className="font-mono">@{status.replaced}</span> for {workspace.name}.
        </p>
      )}
      {others.length > 0 && (
        <p className="m-0 pl-[28px] text-sm text-fg-muted">Also used by {others.join(" and ")}.</p>
      )}
    </div>
  );
}

/**
 * The host said yes, but the account already serves another workspace. Nothing is saved until the
 * owner confirms; Cancel drops the sign-in.
 */
function Confirm({
  status,
  workspace,
  names,
  onClose,
}: {
  status: Extract<SignInStatus, { state: "confirm" }>;
  workspace: OnboardingWorkspace;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const confirm = useSignInConfirm();
  const cancel = useSignInCancel();
  const others = status.alsoUsedBy.map((id) => names.get(id) ?? id).join(" and ");
  const label = HOST_LABEL[status.kind];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-amber-line bg-amber-wash p-4">
        <p className="m-0 flex items-start gap-2.5 text-base text-fg-soft text-pretty">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
          <span>
            <span className="font-mono">@{status.account}</span> on {label} is already used by {others}. If{" "}
            {workspace.name} uses it too, work in both can reach the same repos.
          </span>
        </p>
        {status.replaced && (
          <p className="m-0 pl-[26px] text-sm text-fg-muted">
            It would replace <span className="font-mono">@{status.replaced}</span> for {workspace.name}.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pl-[26px]">
          <Button
            variant="primary"
            disabled={confirm.isPending || cancel.isPending}
            onClick={() => confirm.mutate(status.signIn)}
          >
            {confirm.isPending ? "Saving" : `Use it for ${workspace.name} too`}
          </Button>
          <Button
            variant="ghost"
            disabled={confirm.isPending || cancel.isPending}
            onClick={() => cancel.mutate(status.signIn, { onSettled: onClose })}
          >
            Cancel, save nothing
          </Button>
          <Expiry until={status.expiresAt} label="Answer within" />
        </div>
      </div>
      {confirm.error && <Problem>{describeError(confirm.error)}</Problem>}
    </div>
  );
}

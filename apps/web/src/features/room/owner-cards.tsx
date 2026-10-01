import type { AccountView, CardOutcome, RoomItem, Task } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { Check, CircleCheck, CirclePause, MessageSquareReply, RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PageLink } from "@/components/ui/page-link";
import { useToast } from "@/components/ui/toast";
import { SignInAgainDialog } from "@/features/accounts/account-dialogs";
import { type RunShip, Ship, type ShipChoices } from "@/features/task/ship";
import { CloseUnshippedDialog, unshippedCount } from "@/features/task/unshipped";
import { useAgentIndex } from "@/lib/agent-index";
import { type ApiRequestError, cmd } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { useFixCheck, useHealthChecks } from "@/lib/ops-queries";
import { useAccounts, useTools } from "@/lib/studio-queries";
import { useAfterTaskChange, useShipOptions } from "@/lib/task-queries";

type Of<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;

/** What the owner cards need from the room around them. */
export interface OwnerContext {
  task: Task;
  /** Puts text in the composer and focuses it. */
  compose: (text: string) => void;
  /** Opens the Changes tab, when the task has repos. */
  showChanges?: (() => void) | undefined;
}

function byName(by: string): string {
  if (by === "owner") return "you";
  if (by === "majhi") return "majhi";
  return `@${by}`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A settled card: one quiet line with what happened, who did it and when. */
function Outcome({ icon, outcome }: { icon: React.ReactNode; outcome: CardOutcome }) {
  return (
    <p className="flex items-center gap-2 pl-[34px] text-sm text-fg-faint">
      {icon}
      <span className="min-w-0 break-words">
        {outcome.text}
        <span className="text-fg-faint">
          {" "}
          · {byName(outcome.by)} · {clock(outcome.at)}
        </span>
      </span>
    </p>
  );
}

/** "Ready for review": Ship, Mark done, Ask for changes, Open changes. Settled: what was done. */
export function ReviewCard({ item, owner }: { item: Of<"review">; owner: OwnerContext | undefined }) {
  if (item.state === "replaced") return null;
  if (item.state === "settled" && item.outcome) {
    return (
      <Outcome
        icon={<CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />}
        outcome={item.outcome}
      />
    );
  }
  if (owner === undefined || owner.task.status !== "review") {
    return (
      <p className="flex items-center gap-2 pl-[34px] text-sm text-fg-faint">
        <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />
        Was ready for review.
      </p>
    );
  }
  return <PendingReview item={item} owner={owner} />;
}

function PendingReview({ item, owner }: { item: Of<"review">; owner: OwnerContext }) {
  const { task } = owner;
  const toast = useToast();
  const after = useAfterTaskChange();
  const options = useShipOptions(task, true);
  const lead = item.lead ?? task.team[0];
  const act = (
    action: "merge" | "mergePush" | "push" | "mr" | "done",
    into?: string,
    choices?: ShipChoices,
    keep = false,
  ) =>
    cmd("room.cardAction", {
      task: task.id,
      item: item.id,
      action,
      ...(into === undefined ? {} : { into }),
      ...(choices === undefined ? {} : choices),
      ...(keep ? { unshipped: "keep" as const } : {}),
    });
  const run: RunShip = async (action, into, choices) => {
    const out = await act(action, into, choices);
    await after();
    return out;
  };
  const [confirming, setConfirming] = useState(false);
  const done = useMutation<unknown, ApiRequestError, boolean>({
    mutationFn: (keep) => act("done", undefined, undefined, keep),
    onSuccess: () => {
      setConfirming(false);
      return after();
    },
    onError: (error, keep) => {
      if (!keep) toast("Could not mark it done", { detail: describeError(error), tone: "error" });
    },
  });
  const doneOption = options.data?.done;
  const unshipped = doneOption?.unshipped ?? [];

  return (
    <section
      aria-label="Ready for review"
      className="flex max-w-[700px] flex-col gap-2.5 rounded-lg border border-green-line bg-green-wash px-3.5 py-3"
    >
      <p className="flex items-start gap-2 text-base text-fg">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-green" />
        <span className="min-w-0 break-words">
          <span className="font-medium">Ready for review.</span>{" "}
          <span className="text-fg-muted">The agents are done and wait for you.</span>
        </span>
      </p>
      {item.why !== undefined && <p className="pl-6 text-sm text-amber text-pretty">{item.why}</p>}
      <div className="flex flex-wrap items-center gap-2 pl-6">
        {task.repos.length > 0 && <Ship task={task} run={run} lead={lead} align="left" variant="primary" />}
        <Button
          size="sm"
          variant={task.repos.length > 0 ? "secondary" : "primary"}
          disabled={done.isPending || doneOption?.ok === false}
          title={doneOption?.ok === false ? doneOption.why : "Mark the task done. Nothing is merged."}
          onClick={() => (unshipped.length > 0 ? setConfirming(true) : done.mutate(false))}
        >
          <Check aria-hidden="true" />
          Mark done
        </Button>
        {lead !== undefined && (
          <Button size="sm" onClick={() => owner.compose(`@${lead} `)}>
            Ask for changes
          </Button>
        )}
        {owner.showChanges && (
          <Button size="sm" variant="ghost" className="px-2" onClick={owner.showChanges}>
            Open changes
          </Button>
        )}
      </div>
      {doneOption?.ok === false && (
        <p className="pl-6 text-xs text-fg-muted text-pretty">Mark done: {doneOption.why}</p>
      )}
      {doneOption?.ok === true && unshipped.length > 0 && (
        <p className="pl-6 text-xs text-amber-soft text-pretty">
          {unshippedCount(unshipped)}. Ship it, or mark it done to leave the commits on the branch.
        </p>
      )}
      {confirming && (
        <CloseUnshippedDialog
          unshipped={unshipped}
          busy={done.isPending}
          error={done.error === null ? undefined : describeError(done.error)}
          onCancel={() => setConfirming(false)}
          onConfirm={() => done.mutate(true)}
        />
      )}
    </section>
  );
}

const PAUSE_WHY: Record<Of<"paused">["reason"], string> = {
  owner: "You stopped it.",
  loop: "The agents handed work back and forth without changing a file, so majhi paused them. Reply or Resume to continue.",
  blocked: "A task it waits on changed. See the room for what to do.",
  offline: "majhi lost its connection. It resumes by itself when the connection is back.",
  error: "An agent hit an error it could not get past.",
  limit: "A weekly budget reached 100%. It continues when the budget is raised or on Monday.",
};

/** The task paused: Resume, and the fix when majhi knows the cause. Settled: what happened. */
export function PausedCard({ item, owner }: { item: Of<"paused">; owner: OwnerContext | undefined }) {
  if (item.state === "replaced") return null;
  if (item.state === "settled" && item.outcome) {
    return (
      <Outcome
        icon={<CirclePause aria-hidden="true" className="size-3.5 shrink-0" />}
        outcome={item.outcome}
      />
    );
  }
  if (owner === undefined || owner.task.status !== "paused") return null;
  return <PendingPause item={item} task={owner.task} />;
}

function PendingPause({ item, task }: { item: Of<"paused">; task: Task }) {
  const toast = useToast();
  const after = useAfterTaskChange();
  const resume = useMutation<unknown, ApiRequestError>({
    mutationFn: () => cmd("room.cardAction", { task: task.id, item: item.id, action: "resume" }),
    onSuccess: () => after(),
    onError: (error) => toast("Could not resume", { detail: describeError(error), tone: "error" }),
  });
  return (
    <section
      aria-label="Paused"
      className="flex max-w-[700px] flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
    >
      <p className="flex items-start gap-2 text-base text-fg">
        <CirclePause aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
        <span className="min-w-0 break-words">
          <span className="font-medium">Paused.</span>{" "}
          <span className="text-fg-muted">{PAUSE_WHY[item.reason]}</span>
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <Button size="sm" variant="primary" disabled={resume.isPending} onClick={() => resume.mutate()}>
          <RotateCw aria-hidden="true" />
          Resume
        </Button>
        {item.reason !== "owner" && item.reason !== "offline" && <PauseFixes task={task} />}
      </div>
    </section>
  );
}

/** What majhi knows about why agents cannot run: a signed-out account, a usage limit, a missing runner. */
function PauseFixes({ task }: { task: Task }) {
  const index = useAgentIndex();
  const accounts = useAccounts().data ?? [];
  const tools = useTools().data;
  const checks = useHealthChecks().data?.checks ?? [];
  const fix = useFixCheck();
  const toast = useToast();
  const [signIn, setSignIn] = useState<AccountView>();

  const used = new Set(task.team.flatMap((id) => index.get(id)?.account ?? []));
  const team = accounts.filter((a) => used.has(a.id));
  const signedOut = team.filter((a) => a.status === "needs-login" || a.status === "relogin-soon");
  const limited = team.filter((a) => a.status === "at-limit");
  const runner = checks.find((c) => c.id === "runner" && !c.ok && c.fix !== undefined);

  return (
    <>
      {signedOut.map((a) => (
        <Button key={a.id} size="sm" onClick={() => setSignIn(a)}>
          Sign in to {a.id}
        </Button>
      ))}
      {limited.map((a) => (
        <Button key={a.id} size="sm" asChild>
          <PageLink page="accounts" search={{ account: a.id }}>
            Open {a.id}
            {resetOf(a) && <span className="font-normal text-fg-muted">resets {resetOf(a)}</span>}
          </PageLink>
        </Button>
      ))}
      {runner && (
        <Button
          size="sm"
          disabled={fix.isPending}
          title={runner.detail}
          onClick={() =>
            fix.mutate("runner", {
              onSuccess: (out) =>
                toast(out.ok ? "Rebuilding majhi" : "Could not rebuild", {
                  detail: out.detail,
                  tone: out.ok ? "success" : "error",
                }),
              onError: (error) => toast("Could not rebuild", { detail: describeError(error), tone: "error" }),
            })
          }
        >
          Rebuild majhi
        </Button>
      )}
      {signIn && (
        <SignInAgainDialog
          account={signIn}
          tool={tools?.find((t) => t.id === signIn.tool)}
          onClose={() => setSignIn(undefined)}
        />
      )}
    </>
  );
}

/** When the full window of an account at its limit resets, as a short time or day. */
function resetOf(account: AccountView): string | undefined {
  const u = account.usage;
  const full = [u?.window, u?.weekly].find((w) => w !== undefined && w.usedPct >= 100 && w.resetsAt);
  const at = full?.resetsAt ?? u?.window?.resetsAt;
  if (at === undefined) return undefined;
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? `at ${clock(at)}`
    : date.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** Under an agent's plain-text question to the owner: Reply, and one button per choice. */
export function QuestionActions({
  item,
  owner,
}: {
  item: Of<"owner-question">;
  owner: OwnerContext | undefined;
}) {
  const toast = useToast();
  const pick = useMutation<unknown, ApiRequestError, string>({
    mutationFn: (choice) => cmd("room.answerQuestion", { task: item.task, item: item.id, choice }),
    onError: (error) => toast("Could not answer", { detail: describeError(error), tone: "error" }),
  });
  if (item.state === "answered") {
    return (
      <p className="flex items-center gap-2 pl-[34px] text-sm text-fg-faint">
        <MessageSquareReply aria-hidden="true" className="size-3.5 shrink-0" />
        You chose: {item.chosen}
      </p>
    );
  }
  if (item.state !== "pending" || owner === undefined || owner.task.status === "done") return null;
  // With no choices, the review card's Ask for changes already offers the same reply.
  if (item.choices.length === 0 && owner.task.status === "review") return null;
  return (
    <fieldset
      aria-label={`Answer @${item.agent}`}
      className="m-0 flex flex-wrap gap-2 border-0 p-0 pl-[34px]"
    >
      {item.choices.map((choice) => (
        <Button key={choice} size="sm" disabled={pick.isPending} onClick={() => pick.mutate(choice)}>
          {choice}
        </Button>
      ))}
      <Button size="sm" variant="ghost" onClick={() => owner.compose(`@${item.agent} `)}>
        <MessageSquareReply aria-hidden="true" />
        Reply
      </Button>
    </fieldset>
  );
}

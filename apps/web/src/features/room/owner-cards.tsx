import {
  type AccountView,
  type CardOutcome,
  type HandoffState,
  plainAuthorityText,
  type RoomItem,
  type Task,
} from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { Check, CircleCheck, CirclePause, MessageSquareReply, RotateCw, SendHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageLink } from "@/components/ui/page-link";
import { useToast } from "@/components/ui/toast";
import { SignInAgainDialog } from "@/features/accounts/account-dialogs";
import { ChecksOnCommit } from "@/features/handoff/checks-on-commit";
import { FailedStep, HandoffBlock } from "@/features/handoff/handoff-block";
import { type RunShip, Ship, type ShipChoices, type ShipTarget } from "@/features/task/ship";
import { CloseUnshippedDialog, unshippedCount } from "@/features/task/unshipped";
import { useAgentIndex } from "@/lib/agent-index";
import { type ApiRequestError, cmd } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { useHandoff } from "@/lib/handoff-queries";
import { useFixCheck, useHealthChecks } from "@/lib/ops-queries";
import { useAccounts, useOrgs, useTools } from "@/lib/studio-queries";
import { useAfterTaskChange, useShipOptions } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { DockBar } from "./dock-bar";
import { questionLine } from "./question-line";

type Of<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;

/** What the owner cards need from the room around them. */
export interface OwnerContext {
  task: Task;
  /** Puts text in the composer and focuses it. */
  compose: (text: string) => void;
  /** Opens the Changes tab, when the task has repos. */
  showChanges?: (() => void) | undefined;
  /** Agents in the middle of a turn, with the id of their oldest queued owner message. */
  turning?: readonly { agent: string; queuedItem: string | undefined }[] | undefined;
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
          · {outcome.captain ? "Captain" : byName(outcome.by)} · {clock(outcome.at)}
        </span>
      </span>
    </p>
  );
}

/** "Ready to ship": Ship, Mark done, Ask for changes, Open changes. Settled: what was done. */
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
        Was ready to ship.
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
  const now = useNow(15_000);
  const orgs = useOrgs().data;
  // Cards saved before the authority table name a retired level; show the plain rule instead.
  const workspace =
    orgs?.find((o) => o.id === task.org)?.name ?? (task.org === undefined ? "Private" : task.org);
  const lead = item.lead ?? task.team[0];
  const failed = item.why?.startsWith("Checks failed") === true;
  const act = (
    action: "merge" | "mergePush" | "push" | "mr" | "done",
    target?: ShipTarget,
    choices?: ShipChoices,
    keep = false,
  ) =>
    cmd("room.cardAction", {
      task: task.id,
      item: item.id,
      action,
      ...(target === undefined ? {} : target),
      ...(choices === undefined ? {} : choices),
      ...(keep ? { unshipped: "keep" as const } : {}),
    });
  const run: RunShip = async (action, target, choices) => {
    const out = await act(action, target, choices);
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
  // No repo changed since the task started: nothing to ship, so no Ship.
  const shipping =
    task.repos.length > 0 &&
    (options.data?.changed?.length !== 0 || (options.data?.protected ?? []).length > 0);
  const unshipped = doneOption?.unshipped ?? [];

  // The hand-off check is read here too, so the bar's lamp and title say whether it is ready.
  const handoff = useHandoff(task.id, task.repos.length > 0).data;
  const checking = handoff?.running === true || handoff?.queued === true;
  const red = handoff?.current?.verdict === "red" && !checking;
  const notReady = (failed || red) && !checking;
  const queuedMerge = options.data?.queued;
  const cancelQueued = useMutation<unknown, ApiRequestError>({
    mutationFn: () => cmd("tasks.cancelQueuedMerge", { id: task.id }),
    onSuccess: () => after(),
    onError: (error) => toast("Could not cancel it", { detail: describeError(error), tone: "error" }),
  });
  const progress = checkProgress(handoff, now);
  // The checks that failed on this head, by name, for the agent's fix request.
  const failedChecks = (handoff?.current?.steps ?? [])
    .filter((s) => s.status === "fail" || s.status === "timeout" || s.status === "flaky")
    .map((s) => `${s.label}: ${s.detail ?? s.status}`);
  const fix = useMutation({
    mutationFn: () =>
      cmd("room.send", {
        task: task.id,
        text: `@${lead} The hand-off check failed on your latest commit. ${failedChecks.join("; ")}. Read the failure with the hand-off tool, fix it, commit, and say when it is done.`,
      }),
    onError: (error) =>
      toast("Could not send it to the agent", { detail: describeError(error), tone: "error" }),
  });
  // Loaded, and no repo changed: there is nothing to ship, whatever the checks said.
  const nothing = options.data !== undefined && !shipping;
  const why = item.why === undefined ? undefined : plainAuthorityText(item.why, workspace);
  const note =
    doneOption?.ok === false
      ? `Mark done: ${doneOption.why}`
      : doneOption?.ok === true && unshipped.length > 0
        ? `${unshippedCount(unshipped)}. Ship it, or mark it done to leave the commits on the branch.`
        : undefined;
  const line = checking
    ? progress
    : why !== undefined && failed
      ? why
      : (note ??
        (notReady
          ? (handoff?.current?.summary ?? "The agents are done, but the check found a problem.")
          : nothing
            ? "The agents are done. Mark it done to close the task."
            : "The agents are done and wait for you."));

  return (
    <>
      <DockBar
        label={notReady ? "Done, checks failed" : nothing ? "No code changes" : "Ready to ship"}
        lamp={checking ? "working" : notReady ? "needs" : "done"}
        title={checking ? "Checking" : notReady ? "Not ready" : nothing ? "No code changes" : "Ready to ship"}
        line={line}
        below={
          <>
            {notReady && task.repos.length > 0 && <FailedStep task={task.id} />}
            {queuedMerge !== undefined && (
              <p className="m-0 flex items-center gap-2 pl-4 text-sm text-fg-soft">
                <span>
                  Will {queuedMerge.action === "mergePush" ? "merge and push" : "merge"} when checks pass
                </span>
                <span aria-hidden="true">·</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="-mx-1 px-2"
                  disabled={cancelQueued.isPending}
                  onClick={() => cancelQueued.mutate()}
                >
                  Cancel
                </Button>
              </p>
            )}
          </>
        }
        actions={
          <>
            {notReady && lead !== undefined && failedChecks.length > 0 && (
              <Button
                size="sm"
                variant="primary"
                data-primary-action=""
                disabled={fix.isPending}
                onClick={() => fix.mutate()}
              >
                Fix with agent
              </Button>
            )}
            {shipping && (
              <Ship
                task={task}
                run={run}
                lead={lead}
                align="left"
                variant={notReady && failedChecks.length > 0 ? "secondary" : "primary"}
                primaryAction={!(notReady && failedChecks.length > 0)}
              />
            )}
            <Button
              size="sm"
              variant={shipping ? "secondary" : "primary"}
              {...(task.repos.length > 0 ? {} : { "data-primary-action": "" })}
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
          </>
        }
        details={
          <>
            {why !== undefined && <p className="text-amber text-pretty">{why}</p>}
            {item.ready !== undefined && (
              <p className="text-pretty">
                <span className="font-medium">The captain checked it: </span>
                {plainAuthorityText(item.ready, workspace)}
              </p>
            )}
            {task.repos.length > 0 && <HandoffBlock task={task.id} />}
            {note !== undefined && <p className="text-xs text-fg-muted text-pretty">{note}</p>}
            {owner.showChanges && (
              <div>
                <Button size="sm" variant="ghost" className="-ml-2 px-2" onClick={owner.showChanges}>
                  Open changes
                </Button>
              </div>
            )}
          </>
        }
      />
      {confirming && (
        <CloseUnshippedDialog
          unshipped={unshipped}
          busy={done.isPending}
          error={done.error === null ? undefined : describeError(done.error)}
          onCancel={() => setConfirming(false)}
          onConfirm={() => done.mutate(true)}
        />
      )}
    </>
  );
}

/** What a running hand-off check is doing now, in plain words: what is checked, the step and how long it has run. */
function checkProgress(state: HandoffState | undefined, now: number): ReactNode {
  const a = state?.activity;
  if (a === undefined) return <ChecksOnCommit />;
  if (a.phase === "queued")
    return `Waiting for a free slot${a.position === undefined ? "" : `, number ${a.position}`}. Checks come next.`;
  const mins = Math.max(0, Math.floor((now - new Date(a.since).getTime()) / 60_000));
  return <ChecksOnCommit step={a.step} after={mins < 1 ? "under 1 min" : `${mins} min`} />;
}

const PAUSE_WHY: Record<Of<"paused">["reason"], string> = {
  owner: "You stopped it.",
  loop: "The agents handed work back and forth without changing a file, so majhi paused them. Reply or Resume to continue.",
  blocked: "A task it waits on changed. See the room for what to do.",
  offline: "majhi lost its connection. It resumes by itself when the connection is back.",
  error: "An agent hit an error it could not get past.",
  "signed-out": "An account is signed out. Sign in, then resume.",
  limit: "A spending cap or usage limit was reached. It continues when the limit lifts.",
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
  return <PendingPause item={item} task={owner.task} turning={owner.turning ?? []} />;
}

function PendingPause({
  item,
  task,
  turning,
}: {
  item: Of<"paused">;
  task: Task;
  turning: NonNullable<OwnerContext["turning"]>;
}) {
  const toast = useToast();
  const after = useAfterTaskChange();
  const resume = useMutation<unknown, ApiRequestError>({
    mutationFn: () => cmd("room.cardAction", { task: task.id, item: item.id, action: "resume" }),
    onSuccess: () => after(),
    onError: (error) => toast("Could not resume", { detail: describeError(error), tone: "error" }),
  });
  const why =
    item.why ??
    (item.by === "captain" && item.reason === "owner" ? "Captain paused it." : PAUSE_WHY[item.reason]);
  return (
    <DockBar
      label="Paused"
      lamp="paused"
      title="Paused"
      line={why}
      actions={
        <>
          <Button size="sm" variant="primary" disabled={resume.isPending} onClick={() => resume.mutate()}>
            <RotateCw aria-hidden="true" />
            Resume
          </Button>
          {item.reason !== "owner" && item.reason !== "offline" && <PauseFixes task={task} />}
        </>
      }
      details={<p className="text-pretty">{why}</p>}
      below={turning.map((t) => (
        <StillWorking key={t.agent} task={task.id} agent={t.agent} queuedItem={t.queuedItem} />
      ))}
    />
  );
}

/** On a paused card: an agent is still in its turn, so Resume changes nothing for it yet. */
function StillWorking({
  task,
  agent,
  queuedItem,
}: {
  task: string;
  agent: string;
  queuedItem: string | undefined;
}) {
  const toast = useToast();
  const sendNow = useMutation<unknown, ApiRequestError, string>({
    mutationFn: (item) => cmd("room.sendNow", { task, item }),
    onError: (error) => toast("Could not send it now", { detail: describeError(error), tone: "error" }),
  });
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-sm text-fg-muted">
      <span>
        @{agent} is still working on its turn.
        {queuedItem !== undefined && " Your queued message goes when it ends."}
      </span>
      {queuedItem !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          disabled={sendNow.isPending}
          title={`Stop @${agent}'s current turn and send your oldest queued message now`}
          onClick={() => sendNow.mutate(queuedItem)}
        >
          <SendHorizontal aria-hidden="true" />
          Send now
        </Button>
      )}
    </p>
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
        {item.by === "captain" ? "Captain" : "You"} chose: {item.chosen}
      </p>
    );
  }
  if (item.state !== "pending" || owner === undefined || owner.task.status === "done") return null;
  // With no choices, the review card's Ask for changes already offers the same reply.
  if (item.choices.length === 0 && owner.task.status === "review") return null;
  const line = questionLine(item);
  return (
    <DockBar
      label={`Answer @${item.agent}`}
      lamp="needs"
      title={line.text === undefined ? `${line.who} asked for you` : `${line.who} asks`}
      line={line.text}
      actions={
        <>
          {item.choices.map((choice) => (
            <Button key={choice} size="sm" disabled={pick.isPending} onClick={() => pick.mutate(choice)}>
              {choice}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => owner.compose(`@${item.agent} `)}>
            <MessageSquareReply aria-hidden="true" />
            Reply
          </Button>
        </>
      }
      details={line.text === undefined ? undefined : <p className="text-pretty">{line.text}</p>}
    />
  );
}

import type { Fact } from "@majhi/shared";
import { Pin } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { AgentRef } from "@/features/agent-drawer/agent-ref";
import { TaskRef } from "@/features/task-drawer/task-ref";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import {
  useApproveFact,
  useForgetFact,
  usePinFact,
  usePromoteFact,
  useRejectFact,
} from "@/lib/memory-queries";
import { scopeKind, scopeText } from "./model";

type Confirm = "forget" | "promote";

/**
 * One fact: its words, where it holds, where it came from and how often tasks got it, with the
 * actions that fit its state. A pending fact can be approved or rejected; an active one pinned,
 * added to the repo's AGENTS.md (project facts only) or forgotten.
 */
export function FactRow({ fact, orgNames }: { fact: Fact; orgNames: ReadonlyMap<string, string> }) {
  const toast = useToast();
  const approve = useApproveFact();
  const reject = useRejectFact();
  const pin = usePinFact();
  const forget = useForgetFact();
  const promote = usePromoteFact();
  const [confirm, setConfirm] = useState<Confirm>();
  const [problem, setProblem] = useState<string>();
  const pending = fact.status === "pending";
  const canPromote =
    fact.status === "active" && scopeKind(fact.scope) === "project" && fact.promoted === undefined;
  const fail = (title: string) => (e: unknown) => toast(title, { detail: describeError(e), tone: "error" });

  return (
    <li className="flex flex-col gap-1.5 rounded-xl border border-line-strong bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <p className="m-0 min-w-0 flex-1 text-body text-fg text-pretty [overflow-wrap:anywhere]">
          {fact.text}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {pending ? (
            <>
              <Button
                size="sm"
                variant="primary"
                aria-label={`Approve: ${fact.text}`}
                disabled={approve.isPending}
                onClick={() => approve.mutate({ id: fact.id }, { onError: fail("Could not approve") })}
              >
                Approve
              </Button>
              <Button
                size="sm"
                aria-label={`Reject: ${fact.text}`}
                disabled={reject.isPending}
                onClick={() => reject.mutate({ id: fact.id }, { onError: fail("Could not reject") })}
              >
                Reject
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                aria-pressed={fact.pinned}
                aria-label={`${fact.pinned ? "Unpin" : "Pin"}: ${fact.text}`}
                disabled={pin.isPending}
                onClick={() =>
                  pin.mutate(
                    { id: fact.id, pinned: !fact.pinned },
                    { onError: fail("Could not change the pin") },
                  )
                }
              >
                {fact.pinned ? "Unpin" : "Pin"}
              </Button>
              {canPromote && (
                <Button
                  size="sm"
                  aria-label={`To AGENTS.md: ${fact.text}`}
                  onClick={() => setConfirm("promote")}
                >
                  To AGENTS.md
                </Button>
              )}
              <Button size="sm" aria-label={`Forget: ${fact.text}`} onClick={() => setConfirm("forget")}>
                Forget
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-fg-faint">
        <Badge tone={scopeKind(fact.scope) === "global" ? "blue" : "neutral"}>
          {scopeText(fact.scope, orgNames)}
        </Badge>
        {pending && <Badge tone="amber">Needs review</Badge>}
        {fact.pinned && (
          <Badge tone="amber">
            <Pin aria-hidden="true" />
            Pinned
          </Badge>
        )}
        {fact.promoted !== undefined && (
          <Badge tone="green">
            In AGENTS.md via <TaskRef id={fact.promoted} />
          </Badge>
        )}
        {fact.task !== undefined && (
          <span>
            From <TaskRef id={fact.task} />
            {fact.agent !== undefined && fact.agent !== "owner" && (
              <>
                {" by "}
                <AgentRef id={fact.agent} />
              </>
            )}
          </span>
        )}
        {fact.task === undefined && fact.agent === "owner" && <span>Added by you</span>}
        <span className={cn(fact.use_count === 0 && "text-fg-faint")}>
          Used in {plural(fact.use_count, "task")}
        </span>
      </div>
      {confirm === "forget" && (
        <ConfirmDialog
          title="Forget this fact?"
          body={
            <>
              <q>{fact.text}</q> stops being recalled in new tasks. It stays in the log, and Undo brings it
              back.
            </>
          }
          confirmLabel="Forget"
          busy={forget.isPending}
          error={problem}
          onCancel={() => {
            setConfirm(undefined);
            setProblem(undefined);
          }}
          onConfirm={() =>
            forget.mutate(
              { id: fact.id },
              {
                onSuccess: () => setConfirm(undefined),
                onError: (e) => setProblem(describeError(e)),
              },
            )
          }
        />
      )}
      {confirm === "promote" && (
        <ConfirmDialog
          title="Add this fact to AGENTS.md?"
          body={
            <>
              majhi makes a task in this project that adds <q>{fact.text}</q> to the repo's AGENTS.md, with
              one commit, and leaves it in review. Nothing changes in the repo until you merge that task.
            </>
          }
          confirmLabel="Make the task"
          busy={promote.isPending}
          error={problem}
          onCancel={() => {
            setConfirm(undefined);
            setProblem(undefined);
          }}
          onConfirm={() =>
            promote.mutate(
              { id: fact.id },
              {
                onSuccess: (out) => {
                  setConfirm(undefined);
                  toast(`Made ${out.task}`, { detail: "It waits in review for you to merge." });
                },
                onError: (e) => setProblem(describeError(e)),
              },
            )
          }
        />
      )}
    </li>
  );
}

import { isDestructiveCommand, type RoomItem } from "@majhi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronRight, KeyRound, ShieldCheck, Undo2, Wrench } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageLink } from "@/components/ui/page-link";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import {
  approvalOutcome,
  canUndo,
  RISK_LABEL,
  RISK_TONE,
  type SecretRequestItem,
} from "@/features/boss/model";
import { type ApiRequestError, cmd } from "@/lib/api";
import { useSettings } from "@/lib/boss-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";
import { useTask } from "@/lib/task-queries";
import { DOCK_ACTIONS } from "./dock";
import { SecretAnswer } from "./secret-answer";

type Scope = "task" | "org";

/** What a card says when a saved rule ran it without asking. */
const AUTO_LABEL: Record<Scope, string> = {
  task: "Auto-allowed for this task",
  org: "Auto-allowed in the workspace",
};

type Item<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;

/**
 * A command the captain wants to run. Pending: summary, risk, why, the input folded, Approve and Reject.
 * Settled: one quiet line, with Undo while an applied change can still be undone.
 */
export function ApprovalCard({ item }: { item: Item<"approval"> }) {
  const toast = useToast();
  const client = useQueryClient();
  const decide = useMutation<unknown, ApiRequestError, { decision: "approve" | "reject"; always?: Scope }>({
    mutationFn: ({ decision, always }) =>
      cmd("room.approve", {
        task: item.task,
        item: item.id,
        decision,
        ...(always === undefined ? {} : { always: { scope: always } }),
      }),
    onSuccess: async (_, { always }) => {
      // A saved rule is a settings change: the agent page and Hub setup list it.
      if (always !== undefined) await client.invalidateQueries({ queryKey: queryKeys.settings });
      return client.invalidateQueries({ queryKey: queryKeys.history });
    },
    onError: (error) => toast("Could not answer", { detail: describeError(error), tone: "error" }),
  });
  const undo = useMutation<unknown, ApiRequestError, string>({
    mutationFn: (commit) => cmd("history.undo", { commit }, { reason: "Owner undid a captain change" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.history }),
    onError: (error) => toast("Could not undo", { detail: describeError(error), tone: "error" }),
  });
  const outcome = approvalOutcome(item);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [always, setAlways] = useState(false);
  const [scope, setScope] = useState<Scope>("task");
  const settings = useSettings();
  const org = useTask(item.task).data?.org;
  // No checkbox for a destructive command: only the owner's click approves it. It waits for the settings.
  const canAlways = settings.data !== undefined && !isDestructiveCommand(item.command);

  if (outcome === undefined) {
    return (
      <section
        aria-label={`Approval: ${item.summary}`}
        className="flex max-w-[72ch] flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
      >
        <p className="flex items-start gap-2 text-base text-fg">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
          <span className="min-w-0 break-words">
            <span className="text-fg-muted">@{item.agent} wants to </span>
            <span className="font-medium">{item.summary}</span>
          </span>
          <Badge tone={RISK_TONE[item.risk]} className="ml-auto">
            {RISK_LABEL[item.risk]}
          </Badge>
        </p>
        {item.reason && (
          <p
            title={open ? undefined : item.reason}
            className={cn("pl-6 text-sm text-fg-muted text-pretty", !open && "line-clamp-2")}
          >
            {item.reason}
          </p>
        )}
        {item.autonomy?.decision === "left" && (
          <p className="flex items-start gap-1.5 pl-6 text-sm text-amber text-pretty">
            <Bot aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">Captain left this for you: {item.autonomy.why}</span>
          </p>
        )}
        {item.autonomy?.decision === "left" && item.autonomy.fix !== undefined && (
          <p className="pl-6 text-sm">
            <PageLink
              page={item.autonomy.fix.page}
              search={
                item.autonomy.fix.page === "orgs"
                  ? { org: item.autonomy.fix.org }
                  : { project: item.autonomy.fix.project, section: "remotes" }
              }
              className="inline-flex items-center gap-1 text-blue underline-offset-2 hover:underline"
            >
              <Wrench aria-hidden="true" className="size-3.5" />
              {item.autonomy.fix.page === "orgs" ? "Connect the git account" : "Fix the remote"}
            </PageLink>
          </p>
        )}
        <Details input={item.input} command={item.command} onToggle={setOpen} />
        <div className={cn(DOCK_ACTIONS, "flex gap-2 pl-[34px]")}>
          <Button
            size="sm"
            variant="primary"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ decision: "approve", ...(always ? { always: scope } : {}) })}
          >
            Approve
          </Button>
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ decision: "reject" })}>
            Reject
          </Button>
        </div>
        {canAlways && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-[34px]">
            <label className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
              <input
                type="checkbox"
                checked={always}
                disabled={decide.isPending}
                onChange={(event) => setAlways(event.target.checked)}
              />
              <span className="min-w-0 break-words">
                Always allow <span className="font-mono text-fg-soft">{item.command}</span> for @{item.agent}
              </span>
            </label>
            {always && (
              <Select
                aria-label="Where to always allow it"
                value={scope}
                disabled={decide.isPending}
                onChange={(event) => setScope(event.target.value as Scope)}
                className="h-7 w-auto text-sm"
              >
                <option value="task">In this task</option>
                {org !== undefined && <option value="org">Everywhere in {org}</option>}
              </Select>
            )}
          </div>
        )}
      </section>
    );
  }

  // Older cards carry the command's whole description as their summary; the line names it only.
  const cut = item.summary.indexOf(". ");
  const short = cut === -1 ? item.summary : item.summary.slice(0, cut);
  const label =
    item.state === "applied" && item.autonomy?.decision === "approved"
      ? "Captain approved"
      : item.rule !== undefined && item.state === "applied"
        ? AUTO_LABEL[item.rule]
        : outcome;
  return (
    <div className="flex flex-col pl-[34px]">
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-sm text-fg-faint">
        {item.autonomy?.decision === "approved" ? (
          <Bot aria-hidden="true" className="size-3.5 shrink-0" />
        ) : (
          <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        <span
          className="min-w-0 truncate"
          title={item.autonomy ? `${item.summary}. ${item.autonomy.why}` : item.summary}
        >
          {label}: {short}
        </span>
        <button
          type="button"
          aria-expanded={more}
          aria-label={more ? "Hide details" : "Show details"}
          title={`Details: ${item.command}`}
          onClick={() => setMore((v) => !v)}
          className="grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-xs hover:bg-raised hover:text-fg"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3 transition-transform duration-150", more && "rotate-90")}
          />
        </button>
        {item.state === "failed" && item.result && (
          <span className="min-w-0 truncate text-red" title={item.result}>
            {item.result}
          </span>
        )}
        {canUndo(item) && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            disabled={undo.isPending}
            onClick={() => item.commit && undo.mutate(item.commit)}
          >
            <Undo2 aria-hidden="true" />
            Undo
          </Button>
        )}
      </div>
      {more && (
        <div className="mt-1 mb-1 ml-5 flex max-w-[72ch] flex-col gap-1.5 text-xs text-fg-faint">
          {short !== item.summary && <p className="text-sm text-fg-muted text-pretty">{item.summary}</p>}
          {item.reason && <p className="text-sm text-fg-muted text-pretty">{item.reason}</p>}
          {item.autonomy && (
            <p className="text-sm text-fg-muted text-pretty">
              Captain {item.autonomy.decision === "approved" ? "approved it" : "left it for you"}:{" "}
              {item.autonomy.why}
            </p>
          )}
          <p>
            Input <span className="font-mono">{item.command}</span>
          </p>
          <pre className={PRE}>{item.input}</pre>
          {item.result && (
            <>
              <p>{item.state === "failed" ? "Error" : "Result"}</p>
              <pre className={PRE}>{item.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const PRE =
  "max-h-48 overflow-auto rounded-md bg-sunken p-2 font-mono text-xs break-words whitespace-pre-wrap text-fg-soft";

/** The command's input, folded. Opening it also unclamps the reason above it. */
function Details({
  input,
  command,
  onToggle,
}: {
  input: string;
  command: string;
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
      className="pl-6 text-sm text-fg-muted"
    >
      <summary className="cursor-pointer hover:text-fg">
        Details <span className="font-mono">{command}</span>
      </summary>
      <pre className={cn(PRE, "mt-1.5")}>{input}</pre>
    </details>
  );
}

/**
 * The agent needs a secret. A password field sends it straight to majhi; it is never shown in the
 * room, never echoed, and the agent gets only the reference.
 */
export function SecretRequestCard({ item }: { item: Item<"secret-request"> }) {
  if (item.state !== "pending") return <SecretDone item={item} />;
  return (
    <section
      aria-label={`Secret requested: ${item.label}`}
      className="flex max-w-[72ch] flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
    >
      <p className="flex items-start gap-2 text-base text-fg">
        <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
        <span className="min-w-0 break-words">
          <span className="text-fg-muted">@{item.agent} needs </span>
          <span className="font-medium">{item.label}</span>
        </span>
      </p>
      <div className="pl-6">
        <SecretAnswer task={item.task} item={item.id} label={item.label} name={item.name} />
      </div>
      <p className="pl-6 text-xs text-fg-faint">
        Stored encrypted as secret:{item.name}. The agent sees only that name.
      </p>
    </section>
  );
}

function SecretDone({ item }: { item: SecretRequestItem }) {
  return (
    <p className="flex items-center gap-2 pl-[34px] text-sm text-fg-faint">
      <KeyRound aria-hidden="true" className="size-3.5" />
      {item.state === "saved" ? `Saved ${item.label} as secret:${item.name}` : `Dismissed: ${item.label}`}
    </p>
  );
}

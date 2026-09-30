import type { RoomItem } from "@majhi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, KeyRound, ShieldCheck, Undo2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  approvalOutcome,
  canUndo,
  RISK_LABEL,
  RISK_TONE,
  type SecretRequestItem,
} from "@/features/boss/model";
import { type ApiRequestError, cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";
import { DOCK_ACTIONS } from "./dock";

type Item<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;

/**
 * A command the boss wants to run. Pending: summary, risk, why, the input folded, Approve and Reject.
 * Settled: one quiet line, with Undo while an applied change can still be undone.
 */
export function ApprovalCard({ item }: { item: Item<"approval"> }) {
  const toast = useToast();
  const client = useQueryClient();
  const decide = useMutation<unknown, ApiRequestError, "approve" | "reject">({
    mutationFn: (decision) => cmd("room.approve", { task: item.task, item: item.id, decision }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.history }),
    onError: (error) => toast("Could not answer", { detail: describeError(error), tone: "error" }),
  });
  const undo = useMutation<unknown, ApiRequestError, string>({
    mutationFn: (commit) => cmd("history.undo", { commit }, { reason: "Owner undid a boss change" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.history }),
    onError: (error) => toast("Could not undo", { detail: describeError(error), tone: "error" }),
  });
  const outcome = approvalOutcome(item);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);

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
        <Details input={item.input} command={item.command} onToggle={setOpen} />
        <div className={cn(DOCK_ACTIONS, "flex gap-2 pl-[34px]")}>
          <Button
            size="sm"
            variant="primary"
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            Approve
          </Button>
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate("reject")}>
            Reject
          </Button>
        </div>
      </section>
    );
  }

  // Older cards carry the command's whole description as their summary; the line names it only.
  const cut = item.summary.indexOf(". ");
  const short = cut === -1 ? item.summary : item.summary.slice(0, cut);
  return (
    <div className="flex flex-col pl-[34px]">
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-sm text-fg-faint">
        <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate" title={item.summary}>
          {outcome}: {short}
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
  const toast = useToast();
  const client = useQueryClient();
  const [value, setValue] = useState("");
  const save = useMutation<unknown, ApiRequestError, string>({
    mutationFn: (secret) => cmd("room.secret", { task: item.task, item: item.id, value: secret }),
    onSuccess: () => {
      setValue("");
      return client.invalidateQueries({ queryKey: queryKeys.secrets });
    },
    onError: (error) => toast("Could not save the secret", { detail: describeError(error), tone: "error" }),
  });
  // Cancel is a rejection of the request.
  const cancel = useMutation<unknown, ApiRequestError, void>({
    mutationFn: () => cmd("room.approve", { task: item.task, item: item.id, decision: "reject" }),
    onError: (error) => toast("Could not cancel", { detail: describeError(error), tone: "error" }),
  });

  if (item.state !== "pending") return <SecretDone item={item} />;

  return (
    <form
      aria-label={`Secret requested: ${item.label}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== "") save.mutate(value);
      }}
      className="flex max-w-[72ch] flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
    >
      <p className="flex items-start gap-2 text-base text-fg">
        <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
        <span className="min-w-0 break-words">
          <span className="text-fg-muted">@{item.agent} needs </span>
          <span className="font-medium">{item.label}</span>
        </span>
      </p>
      <div className="flex gap-2 pl-6">
        <Input
          type="password"
          aria-label={`${item.label} (saved as secret:${item.name})`}
          autoComplete="new-password"
          placeholder="Paste it here"
          value={value}
          disabled={save.isPending}
          onChange={(event) => setValue(event.target.value)}
          className="min-w-0 flex-1 font-mono"
        />
        <Button type="submit" size="md" variant="primary" disabled={value === "" || save.isPending}>
          Save
        </Button>
        <Button size="md" disabled={cancel.isPending || save.isPending} onClick={() => cancel.mutate()}>
          Cancel
        </Button>
      </div>
      <p className="pl-6 text-xs text-fg-faint">
        Stored encrypted as secret:{item.name}. The agent sees only that name.
      </p>
    </form>
  );
}

function SecretDone({ item }: { item: SecretRequestItem }) {
  return (
    <p className="flex items-center gap-2 pl-[34px] text-sm text-fg-faint">
      <KeyRound aria-hidden="true" className="size-3.5" />
      {item.state === "saved" ? `Saved ${item.label} as secret:${item.name}` : `Cancelled: ${item.label}`}
    </p>
  );
}

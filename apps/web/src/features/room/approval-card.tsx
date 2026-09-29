import type { RoomItem } from "@majhi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck, Undo2 } from "lucide-react";
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
import { describeError } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";

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

  if (outcome === undefined) {
    return (
      <section
        aria-label={`Approval: ${item.summary}`}
        className="flex max-w-[700px] flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
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
        {item.reason && <p className="pl-6 text-sm text-fg-muted text-pretty">{item.reason}</p>}
        <Details input={item.input} command={item.command} />
        <div className="flex gap-2 pl-6">
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

  return (
    <div className="flex max-w-[700px] flex-col gap-1 pl-[38px]">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-faint">
        <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
        <span>
          {outcome}: {item.summary}
        </span>
        {item.state === "applied" && item.result && (
          <span className="min-w-0 truncate font-mono text-xs" title={item.result}>
            {item.result}
          </span>
        )}
        {item.state === "failed" && item.result && <span className="text-red">{item.result}</span>}
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
      </p>
      <Details input={item.input} command={item.command} quiet />
    </div>
  );
}

function Details({ input, command, quiet }: { input: string; command: string; quiet?: boolean }) {
  return (
    <details className={quiet ? "text-xs text-fg-faint" : "pl-6 text-sm text-fg-muted"}>
      <summary className="cursor-pointer hover:text-fg">
        Details <span className="font-mono">{command}</span>
      </summary>
      <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-sunken p-2 font-mono text-xs break-words whitespace-pre-wrap text-fg-soft">
        {input}
      </pre>
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
      className="flex max-w-[700px] flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
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
    <p className="flex items-center gap-2 pl-[38px] text-sm text-fg-faint">
      <KeyRound aria-hidden="true" className="size-3.5" />
      {item.state === "saved" ? `Saved ${item.label} as secret:${item.name}` : `Cancelled: ${item.label}`}
    </p>
  );
}

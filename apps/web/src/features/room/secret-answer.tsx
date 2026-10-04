import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";

/**
 * The answer to a secret request: a masked field with Save, and Dismiss with an optional one-line reason
 * the asking agent is told. The value goes straight to majhi; it is never shown, echoed or kept here.
 * Used by the room card and by every place that lists what needs the owner.
 */
export function SecretAnswer({
  task,
  item,
  label,
  name,
  compact = false,
}: {
  task: string;
  item: string;
  label: string;
  /** The reference the secret is saved under, when known. */
  name?: string | undefined;
  compact?: boolean;
}) {
  const toast = useToast();
  const client = useQueryClient();
  const [value, setValue] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const done = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.secrets }),
      client.invalidateQueries({ queryKey: queryKeys.decisions }),
    ]);
  };
  const save = useMutation<unknown, ApiRequestError, string>({
    mutationFn: (secret) => cmd("room.secret", { task, item, value: secret }),
    onSuccess: () => {
      setValue("");
      return done();
    },
    onError: (error) => toast("Could not save the secret", { detail: describeError(error), tone: "error" }),
  });
  const dismiss = useMutation<unknown, ApiRequestError, string>({
    mutationFn: (why) =>
      cmd("room.approve", {
        task,
        item,
        decision: "reject",
        ...(why.trim() === "" ? {} : { reason: why.trim() }),
      }),
    onSuccess: done,
    onError: (error) => toast("Could not dismiss", { detail: describeError(error), tone: "error" }),
  });
  const busy = save.isPending || dismiss.isPending;

  return (
    <div className="relative z-10 flex min-w-0 flex-col gap-1.5">
      <form
        className="flex min-w-0 flex-wrap gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (value !== "" && !busy) save.mutate(value);
        }}
      >
        <Input
          type="password"
          aria-label={name === undefined ? label : `${label} (saved as secret:${name})`}
          autoComplete="new-password"
          placeholder="Paste it here"
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          className="min-w-[10rem] flex-1 font-mono"
        />
        <Button type="submit" size={compact ? "sm" : "md"} variant="primary" disabled={value === "" || busy}>
          Save
        </Button>
        <Button
          type="button"
          size={compact ? "sm" : "md"}
          aria-pressed={dismissing}
          disabled={busy}
          onClick={() => setDismissing(!dismissing)}
        >
          Dismiss
        </Button>
      </form>
      {dismissing && (
        <form
          className="flex min-w-0 flex-wrap gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) dismiss.mutate(reason);
          }}
        >
          <Input
            aria-label="Why you are dismissing it (optional)"
            placeholder="Why? (optional, the agent is told)"
            maxLength={300}
            autoFocus
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            className="min-w-[10rem] flex-1"
          />
          <Button type="submit" size={compact ? "sm" : "md"} disabled={busy}>
            Dismiss request
          </Button>
        </form>
      )}
    </div>
  );
}

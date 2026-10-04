import type { ConnectFlowView, ConnectScopeLine } from "@majhi/shared";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";
import { useConnectCommand, useConnectFlow } from "@/lib/connect-queries";
import { describeError } from "@/lib/errors";

/** The access a connection has, one plain sentence each. Write access reads amber. */
export function ScopeList({ scopes }: { scopes: readonly ConnectScopeLine[] }) {
  if (scopes.length === 0) return null;
  return (
    <ul aria-label="Access" className="flex flex-col gap-1">
      {scopes.map((s) => (
        <li key={s.sentence} className="flex items-start gap-2 text-base text-fg-muted text-pretty">
          <span
            className={cn(
              "mt-px w-10 shrink-0 font-mono text-xs uppercase leading-6",
              s.access === "write" ? "text-amber" : "text-fg-faint",
            )}
          >
            {s.access === "other" ? "" : s.access}
          </span>
          <span>{s.sentence}</span>
        </li>
      ))}
    </ul>
  );
}

const LAMP: Record<ConnectFlowView["state"], LampState> = {
  waiting: "working",
  checking: "working",
  "confirm-account": "needs",
  connected: "done",
  denied: "paused",
  expired: "paused",
  failed: "needs",
  cancelled: "idle",
};

/**
 * One connect attempt, from the click to the result: waiting for the owner in the browser (with
 * Cancel, and the link when majhi could not open the page), the account check on a reconnect, and
 * how it ended. `onDone` leaves the card; `onRetry` starts the same attempt again.
 */
export function ConnectFlowCard({
  flow,
  onDone,
  onRetry,
}: {
  flow: string;
  onDone: (connection: string | undefined) => void;
  onRetry: () => void;
}) {
  const query = useConnectFlow(flow);
  const cancel = useConnectCommand("connect.cancel");
  const confirm = useConnectCommand("connect.confirmAccount");
  const [copied, setCopied] = useState(false);
  const view = query.data;
  if (view === undefined) {
    return (
      <p
        role={query.isError ? "alert" : "status"}
        className={cn("text-base", query.isError ? "text-red" : "text-fg-muted")}
      >
        {query.isError ? describeError(query.error) : "Starting"}
      </p>
    );
  }
  const live = view.state === "waiting" || view.state === "checking";
  const lampState = LAMP[view.state];
  const title =
    view.state === "waiting"
      ? "Waiting for you in the browser"
      : view.state === "checking"
        ? "Checking the sign-in"
        : view.state === "confirm-account"
          ? "A different account signed in"
          : view.state === "connected"
            ? view.account
              ? `Connected as ${view.account}`
              : "Connected"
            : view.state === "denied"
              ? "You did not allow it"
              : view.state === "expired"
                ? "The page timed out"
                : view.state === "cancelled"
                  ? "Cancelled"
                  : "Not connected";
  return (
    <div role="status" aria-live="polite" className="flex max-w-[620px] flex-col gap-3">
      <p className={cn("flex items-center gap-2 text-md font-semibold", LAMP_TEXT[lampState])}>
        <Lamp state={lampState} size={9} />
        {title}
      </p>
      {view.state !== "connected" && view.state !== "waiting" && (
        <p className="text-base text-fg-muted text-pretty">{view.message}</p>
      )}
      {view.state === "waiting" && view.url !== undefined && (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-sunken p-3">
          <p className="text-sm text-fg-muted">
            majhi could not open your browser. Open this page yourself, sign in and approve.
          </p>
          <p className="min-w-0 truncate font-mono text-xs text-fg-faint" title={view.url}>
            {view.url}
          </p>
          <div className="flex gap-2">
            <Button size="sm" asChild>
              <a href={view.url} target="_blank" rel="noreferrer noopener">
                <ExternalLink aria-hidden="true" />
                Open the page
              </a>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(view.url ?? "").then(() => setCopied(true));
              }}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      )}
      {view.state === "waiting" && view.url === undefined && (
        <p className="text-sm text-fg-faint">
          The page is open in your browser. This waits up to ten minutes.
        </p>
      )}
      {view.state === "connected" && (
        <>
          <ScopeList scopes={view.scopes} />
          {view.test && (
            <p className={cn("text-base text-pretty", view.test.ok ? "text-fg-muted" : "text-amber")}>
              {view.test.ok ? `Test passed: ${view.test.detail}` : `Test failed: ${view.test.detail}`}
            </p>
          )}
          {view.message.includes("less access") && (
            <p className="text-base text-amber text-pretty">{view.message}</p>
          )}
        </>
      )}
      {view.state === "confirm-account" && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate({ flow, accept: true })}
          >
            Use {view.account ?? "the new account"}
          </Button>
          <Button disabled={confirm.isPending} onClick={() => confirm.mutate({ flow, accept: false })}>
            Keep {view.previousAccount ?? "the old account"}
          </Button>
        </div>
      )}
      {(confirm.error || cancel.error) && (
        <p role="alert" className="text-base text-red">
          {describeError(confirm.error ?? cancel.error)}
        </p>
      )}
      <div className="flex gap-2">
        {live && (
          <Button
            disabled={cancel.isPending}
            onClick={() => cancel.mutate({ flow }, { onSuccess: () => onDone(undefined) })}
          >
            Cancel
          </Button>
        )}
        {view.state === "connected" && (
          <Button variant="primary" onClick={() => onDone(view.connection)}>
            Done
          </Button>
        )}
        {(view.state === "denied" ||
          view.state === "expired" ||
          view.state === "failed" ||
          view.state === "cancelled") && (
          <>
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
            <Button variant="ghost" onClick={() => onDone(undefined)}>
              Back
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

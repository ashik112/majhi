import type { ConnectionView, ConnectState } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { DetailSection } from "@/components/ui/list-detail";
import { cn } from "@/lib/cn";
import { useConnectCommand, useConnectStatus } from "@/lib/connect-queries";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { ConnectFlowCard, ScopeList } from "./connect-flow";

const LAMP: Record<ConnectState, { lamp: LampState; word: string }> = {
  connected: { lamp: "done", word: "Connected" },
  "needs-reconnect": { lamp: "needs", word: "Needs you to sign in again" },
  "insufficient-scope": { lamp: "needs", word: "Needs more access" },
  revoked: { lamp: "needs", word: "Access revoked" },
  error: { lamp: "paused", word: "Last check failed" },
};

/** True for a connection that signed in through Connect. */
export function isOauth(view: Pick<ConnectionView, "fields">): boolean {
  return view.fields.auth?.value === "oauth";
}

/**
 * Who a connection is signed in as, the access it has in plain words, and what to do when it needs
 * you: sign in again, allow more access, or disconnect.
 */
export function ConnectSection({ view, now }: { view: ConnectionView; now: number }) {
  const status = useConnectStatus();
  const start = useConnectCommand("connect.start");
  const disconnect = useConnectCommand("connect.disconnect");
  const [flow, setFlow] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const mine = (status.data ?? []).find((s) => s.connection === view.id);
  if (mine === undefined) return null;
  const look = LAMP[mine.state];
  const reconnect = () => {
    if (mine.service === undefined) return;
    start.mutate(
      {
        org: view.org,
        service: mine.service,
        connection: view.id,
        access: mine.scopes.some((s) => s.access === "write") ? "readwrite" : "read",
      },
      { onSuccess: (f) => setFlow(f.flow) },
    );
  };
  const needsYou = mine.state !== "connected";
  return (
    <DetailSection title="Sign-in" className="border-t-0">
      {flow !== undefined ? (
        <ConnectFlowCard
          flow={flow}
          onRetry={() => {
            setFlow(undefined);
            reconnect();
          }}
          onDone={() => setFlow(undefined)}
        />
      ) : (
        <div className="flex max-w-[620px] flex-col gap-3">
          <p className={cn("flex items-center gap-2 text-base font-medium", LAMP_TEXT[look.lamp])}>
            <Lamp state={look.lamp} size={8} />
            {look.word}
            {mine.connectedAt && mine.state === "connected" && (
              <span className="font-normal text-fg-faint">since {formatAgo(mine.connectedAt, now)}</span>
            )}
          </p>
          <p className="text-base text-fg-muted text-pretty">
            {mine.account ? `Signed in as ${mine.account}. ` : "The service does not say which account. "}
            {mine.renews ? "majhi renews the sign-in by itself." : "This sign-in cannot renew itself."}
          </p>
          {needsYou && <p className="text-base text-amber text-pretty">{mine.reason}</p>}
          <ScopeList scopes={mine.scopes} />
          {start.error && (
            <p role="alert" className="text-base text-red text-pretty">
              {describeError(start.error)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {mine.service !== undefined && (
              <Button
                variant={needsYou ? "primary" : "secondary"}
                disabled={start.isPending}
                onClick={reconnect}
              >
                {mine.state === "insufficient-scope" ? "Allow more access" : "Reconnect"}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setLeaving(true)}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
      {leaving && (
        <ConfirmDialog
          title={`Disconnect ${mine.serviceName}?`}
          body={
            <>
              majhi asks {mine.serviceName} to revoke its access and deletes the sign-in. Agents lose the
              connection.{" "}
              {mine.revocable
                ? ""
                : `${mine.serviceName} may keep the access until you remove majhi in its settings.`}
            </>
          }
          confirmLabel="Disconnect"
          busy={disconnect.isPending}
          error={disconnect.error ? describeError(disconnect.error) : undefined}
          onCancel={() => setLeaving(false)}
          onConfirm={() => disconnect.mutate({ connection: view.id }, { onSuccess: () => setLeaving(false) })}
        />
      )}
    </DetailSection>
  );
}

import type { ConnectionView, ConnectStatus } from "@majhi/shared";
import { useState } from "react";
import { useConnectCommand, useConnectStatus } from "@/lib/connect-queries";

/** True for a connection that signed in through Connect: its token is majhi's to renew and send. */
export function isOauth(view: Pick<ConnectionView, "fields" | "type">): boolean {
  return (
    view.fields.auth?.value === "oauth" ||
    view.type === "api" ||
    view.type === "cli" ||
    (view.type === "env" && view.fields.service?.value !== undefined)
  );
}

/**
 * What Connect holds for a connection (who signed in, the access in plain words, whether the token
 * renews) and how to sign in again. The state of the connection itself is its `health`; this adds the
 * facts and the action, never a second status.
 */
export function useReconnect(view: ConnectionView): {
  mine: ConnectStatus | undefined;
  flow: string | undefined;
  canReconnect: boolean;
  pending: boolean;
  error: unknown;
  reconnect: () => void;
  clear: () => void;
} {
  const status = useConnectStatus();
  const start = useConnectCommand("connect.start");
  const [flow, setFlow] = useState<string>();
  const mine = (status.data ?? []).find((s) => s.connection === view.id);
  const canReconnect =
    mine !== undefined && (mine.service !== undefined || view.type === "mcp") && view.type !== "env";
  const reconnect = () => {
    if (mine === undefined) return;
    start.mutate(
      {
        org: view.org,
        ...(mine.service === undefined ? {} : { service: mine.service }),
        connection: view.id,
        access: mine.scopes.some((s) => s.access === "write") ? "readwrite" : "read",
      },
      { onSuccess: (f) => setFlow(f.flow) },
    );
  };
  return {
    mine,
    flow,
    canReconnect,
    pending: start.isPending,
    error: start.error,
    reconnect,
    clear: () => setFlow(undefined),
  };
}

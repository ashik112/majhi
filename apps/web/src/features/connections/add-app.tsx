import { type ConnectAccess, type ServiceEntry, serviceById } from "@majhi/shared";
import { Check, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { useAppSetup, useAppStatus, useConnectCommand } from "@/lib/connect-queries";
import { useConnectionCommand, useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { useNow } from "@/lib/use-now";
import { AppSetupSheet } from "./app-setup-sheet";
import { ConnectFlowCard } from "./connect-flow";
import { ServiceLogo, serviceOf } from "./service-logo";
import { fixOf, rowStatus } from "./status";

/**
 * A service that needs the owner's own app (Google's Gmail, Calendar and Drive from one client, or
 * Outlook). One guided sheet makes the app. Then each service signs in on that one app, and the setup
 * steps that can only be known by calling the service (the API is on, the app is published) check
 * themselves with the stored sign-in.
 */
export function AppBackedBody({
  org,
  entries,
  app,
  onDone,
}: {
  org: string;
  entries: readonly ServiceEntry[];
  app: string;
  onDone: (connection?: string) => void;
}) {
  const apps = useAppStatus(org);
  const [again, setAgain] = useState(false);
  const saved = (apps.data ?? []).find((a) => a.app === app)?.saved === true;
  if (apps.isPending) return <p className="text-base text-fg-muted">Loading</p>;
  if (!saved || again) {
    return (
      <AppSetupSheet
        org={org}
        app={app}
        access="read"
        serviceName={entries[0]?.name ?? "the service"}
        onDone={(done) => {
          if (done) setAgain(false);
          else if (again) setAgain(false);
          else onDone();
        }}
      />
    );
  }
  return (
    <ConnectPhase org={org} entries={entries} app={app} onChangeApp={() => setAgain(true)} onDone={onDone} />
  );
}

function ConnectPhase({
  org,
  entries,
  app,
  onChangeApp,
  onDone,
}: {
  org: string;
  entries: readonly ServiceEntry[];
  app: string;
  onChangeApp: () => void;
  onDone: (connection?: string) => void;
}) {
  const connections = useConnections();
  const start = useConnectCommand("connect.start");
  const test = useConnectionCommand("connections.test");
  const setup = useAppSetup(org, app, "read");
  const now = useNow(30_000);
  const [write, setWrite] = useState(false);
  const [active, setActive] = useState<{ service: string; flow: string }>();
  const access: ConnectAccess = write ? "readwrite" : "read";
  const mine = (entry: ServiceEntry) =>
    (connections.data ?? []).find((c) => c.org === org && serviceOf(c) === entry.id);
  const mineAll = entries.flatMap((e) => {
    const c = mine(e);
    return c === undefined ? [] : [c];
  });
  const begin = (entry: ServiceEntry, connection?: string) =>
    start.mutate(
      { org, service: entry.id, access, ...(connection === undefined ? {} : { connection }) },
      { onSuccess: (view) => setActive({ service: entry.id, flow: view.flow }) },
    );
  const checkAll = () => {
    for (const c of mineAll) test.mutate({ id: c.id });
  };
  const apiSteps = (setup.data?.steps ?? []).filter((s) => s.check === "apis" || s.check === "published");
  const inTesting = mineAll.some(
    (c) =>
      (c.health?.state === "failed" || c.health?.state === "needs-attention") &&
      c.health.reason === "app-in-testing",
  );

  return (
    <div className="flex max-w-[680px] flex-col gap-5">
      <section aria-label="Services" className="flex flex-col gap-2">
        <h4 className="text-sm font-medium text-fg-soft">Connect on the app you made</h4>
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {entries.map((entry) => {
            const have = mine(entry);
            const status = have === undefined ? undefined : rowStatus(have.health, false, now);
            const running = active?.service === entry.id;
            return (
              <li key={entry.id} className="flex flex-col gap-3 px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <ServiceLogo service={entry.id} className="size-8" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium">{entry.name}</span>
                    <span className="block truncate text-sm text-fg-muted">{entry.summary}</span>
                  </span>
                  {status !== undefined && (
                    <span className={cn("flex shrink-0 items-center gap-2 text-sm", LAMP_TEXT[status.lamp])}>
                      <Lamp state={status.lamp} size={7} />
                      {status.word}
                    </span>
                  )}
                  {!running && (
                    <Button
                      size="sm"
                      variant={have === undefined ? "primary" : "secondary"}
                      disabled={start.isPending}
                      onClick={() => begin(entry, have?.id)}
                    >
                      {have === undefined ? "Connect" : "Sign in again"}
                    </Button>
                  )}
                </div>
                {running && active !== undefined && (
                  <ConnectFlowCard
                    flow={active.flow}
                    onRetry={() => begin(entry, have?.id)}
                    onDone={(connection) => {
                      setActive(undefined);
                      if (connection !== undefined && entries.length === 1) onDone(connection);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
        <Switch
          label="Also let agents change things"
          checked={write}
          onChange={setWrite}
          title="Writes still ask you first unless the workspace allows that exact action"
        />
        {start.error && (
          <p role="alert" className="text-base text-red text-pretty">
            {describeError(start.error)}
          </p>
        )}
      </section>

      {apiSteps.length > 0 && (
        <section aria-label="Setup checks" className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex items-center gap-3">
            <h4 className="text-sm font-medium text-fg-soft">Check the setup</h4>
            <Button
              size="sm"
              className="ml-auto"
              disabled={mineAll.length === 0 || test.isPending}
              onClick={checkAll}
            >
              {test.isPending ? "Checking" : "Check again"}
            </Button>
          </div>
          {mineAll.length === 0 && (
            <p className="text-sm text-fg-faint">
              Connect a service above first. Each check calls it with your sign-in.
            </p>
          )}
          <ol className="flex flex-col gap-3">
            {apiSteps.map((step) => (
              <li key={step.n} className="flex flex-col gap-1.5">
                <p className="text-base font-medium text-fg">{step.title}</p>
                <p className="text-sm text-fg-muted text-pretty">{step.body}</p>
                <div className="flex flex-wrap gap-2">
                  {step.links.map((l) => (
                    <Button key={l.url} size="sm" asChild>
                      <a href={l.url} target="_blank" rel="noreferrer noopener">
                        <ExternalLink aria-hidden="true" />
                        {l.label}
                      </a>
                    </Button>
                  ))}
                </div>
                <SetupLines kind={step.check} connections={mineAll} testing={inTesting} />
              </li>
            ))}
          </ol>
        </section>
      )}
      <div>
        <Button variant="ghost" size="sm" onClick={onChangeApp}>
          Change the app
        </Button>
      </div>
    </div>
  );
}

/** What a check found, per service: on, or the exact page that turns it on. */
function SetupLines({
  kind,
  connections,
  testing,
}: {
  kind: "apis" | "published" | "client" | undefined;
  connections: ReturnType<typeof useConnections>["data"] & object;
  testing: boolean;
}) {
  if (connections.length === 0) return null;
  if (kind === "published") {
    const waiting = connections.some((c) => c.health?.state === "connected" || testing);
    return (
      <p className={cn("flex items-center gap-2 text-sm", testing ? "text-amber" : "text-fg-muted")}>
        {testing ? (
          "Still in Testing: Google ends the sign-in after 7 days. Publish the app, then sign in again."
        ) : waiting ? (
          <>
            <Check aria-hidden="true" className="size-3.5 text-green" />
            The sign-in does not end in 7 days.
          </>
        ) : null}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {connections.map((c) => {
        const fix = fixOf(c.health);
        const name = serviceById(c.fields.service?.value ?? "")?.name ?? c.name;
        const off =
          c.health?.state === "needs-attention" || c.health?.state === "failed"
            ? c.health.reason === "setup-needed"
            : false;
        return (
          <li key={c.id} className="flex flex-wrap items-center gap-x-2 text-sm text-fg-muted">
            {c.health?.state === "connected" ? (
              <Check aria-hidden="true" className="size-3.5 text-green" />
            ) : (
              <Lamp state={off ? "needs" : "idle"} size={6} />
            )}
            <span className="text-fg">{name}</span>
            {c.health?.state === "connected" ? "answers" : (fix?.text ?? "not checked yet")}
            {off && fix?.url !== undefined && (
              <a
                href={fix.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-fg underline underline-offset-2"
              >
                Turn it on
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Slack and Discord: the app's tokens are the sign-in, and saving them checks them. */
export function TokenAppBody({
  org,
  entry,
  onDone,
}: {
  org: string;
  entry: ServiceEntry;
  onDone: (connection?: string) => void;
}) {
  return (
    <AppSetupSheet
      org={org}
      app={entry.app ?? entry.id}
      access="read"
      serviceName={entry.name}
      onDone={(saved, connection) => onDone(saved ? connection : undefined)}
    />
  );
}

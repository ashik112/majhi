import type { ConnectStatus, OrgView, ServiceEntry } from "@majhi/shared";
import { ArrowLeft, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailPane } from "@/components/ui/list-detail";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { useConnectCatalog, useConnectCommand, useConnectStatus } from "@/lib/connect-queries";
import { describeError } from "@/lib/errors";
import { ConnectFlowCard, ScopeList } from "./connect-flow";

/** Matches the name and the one-line summary, ignoring case. */
export function matchesService(service: Pick<ServiceEntry, "name" | "summary">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || `${service.name} ${service.summary}`.toLowerCase().includes(q);
}

/**
 * The services majhi connects with one click, for one workspace. Pick one, read what it can do,
 * connect in the browser, and see who signed in. A service already connected in the workspace opens
 * its connection instead.
 */
export function ConnectCatalog({
  orgs,
  defaultOrg,
  onOpen,
  onClose,
}: {
  orgs: readonly OrgView[];
  defaultOrg: string | undefined;
  onOpen: (connection: string) => void;
  onClose: () => void;
}) {
  const catalog = useConnectCatalog();
  const status = useConnectStatus();
  const start = useConnectCommand("connect.start");
  const [org, setOrg] = useState(defaultOrg ?? orgs[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ServiceEntry>();
  const [write, setWrite] = useState(false);
  const [flow, setFlow] = useState<string>();

  const services = useMemo(
    () => (catalog.data?.services ?? []).filter((s) => matchesService(s, query)),
    [catalog.data, query],
  );
  const connected = (service: ServiceEntry): ConnectStatus | undefined =>
    (status.data ?? []).find((s) => s.org === org && s.service === service.id);
  const orgName = orgs.find((o) => o.id === org)?.name ?? org;

  const begin = (service: ServiceEntry) =>
    start.mutate(
      { org, service: service.id, access: write ? "readwrite" : "read" },
      { onSuccess: (view) => setFlow(view.flow) },
    );

  return (
    <DetailPane
      label="Connect a service"
      head={
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2 className="text-md leading-6 font-semibold">Connect a service</h2>
          <p className="min-w-0 text-sm text-fg-muted">Sign in once in your browser. No tokens to copy.</p>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="flex items-center gap-2 text-sm text-fg-faint">
              Workspace
              <Select
                aria-label="Workspace"
                className="w-[180px]"
                value={org}
                disabled={flow !== undefined}
                onChange={(e) => setOrg(e.target.value)}
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </span>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      }
    >
      {catalog.isError ? (
        <p role="alert" className="pt-5 text-base text-red">
          Could not load the services: {describeError(catalog.error)}
        </p>
      ) : picked !== undefined ? (
        <div className="flex flex-col gap-4 pt-4">
          {flow === undefined && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setPicked(undefined)}>
              <ArrowLeft aria-hidden="true" />
              All services
            </Button>
          )}
          <h3 className="text-md font-semibold">
            {picked.name} <span className="font-normal text-fg-muted">for {orgName}</span>
          </h3>
          {flow !== undefined ? (
            <ConnectFlowCard
              flow={flow}
              onRetry={() => {
                setFlow(undefined);
                begin(picked);
              }}
              onDone={(connection) => {
                setFlow(undefined);
                if (connection !== undefined) onOpen(connection);
                else setPicked(undefined);
              }}
            />
          ) : (
            <div className="flex max-w-[620px] flex-col gap-4">
              <p className="text-base text-fg-muted text-pretty">
                majhi opens {picked.name}'s own sign-in page in your browser. Agents of {orgName} can then use{" "}
                {picked.name}. Other workspaces never get this sign-in.
              </p>
              <ScopeList
                scopes={picked.scopes
                  .filter((s) => s.access === "read" || write)
                  .map((s) => ({ access: s.access, sentence: s.sentence }))}
              />
              {picked.scopes.some((s) => s.access === "write") && (
                <Switch
                  label="Also let agents change things"
                  checked={write}
                  onChange={setWrite}
                  title="Writes still ask you first unless the workspace allows that exact action"
                />
              )}
              {picked.scopes.some((s) => s.oauth === undefined) && (
                <p className="text-sm text-fg-faint text-pretty">
                  {picked.name} decides what its page offers. majhi shows what it granted.
                </p>
              )}
              {picked.note && <p className="text-sm text-amber text-pretty">{picked.note}</p>}
              {start.error && (
                <p role="alert" className="text-base text-red text-pretty">
                  {describeError(start.error)}
                </p>
              )}
              <div className="flex items-center gap-3">
                <Button
                  variant="primary"
                  disabled={start.isPending || org === ""}
                  onClick={() => begin(picked)}
                >
                  {start.isPending ? "Opening" : `Connect ${picked.name}`}
                </Button>
                <a
                  href={picked.docs}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm text-fg-faint underline-offset-2 hover:text-fg hover:underline"
                >
                  {picked.name} docs
                </a>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4 pt-4">
          <Field label="Search services">
            {(props) => (
              <div className="relative max-w-[360px]">
                <Search aria-hidden="true" className="absolute top-2.5 left-2.5 size-3.5 text-fg-faint" />
                <Input
                  {...props}
                  type="search"
                  autoFocus
                  className="pl-8"
                  placeholder="Linear, Sentry, Stripe"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )}
          </Field>
          {catalog.isPending ? (
            <p className="text-base text-fg-muted">Loading</p>
          ) : services.length === 0 ? (
            <p className="text-base text-fg-muted">No service matches "{query}".</p>
          ) : (
            <ul aria-label="Services" className="grid gap-2 @[560px]:grid-cols-2 @[900px]:grid-cols-3">
              {services.map((s) => {
                const have = connected(s);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      disabled={!s.ready}
                      onClick={() => {
                        if (have !== undefined) onOpen(have.connection);
                        else {
                          setPicked(s);
                          setWrite(false);
                          start.reset();
                        }
                      }}
                      className={cn(
                        "flex h-full w-full min-w-0 flex-col gap-1 rounded-lg border border-line bg-raised p-3 text-left",
                        "hover:border-line-hover focus-visible:outline-2 focus-visible:outline-accent",
                        "disabled:cursor-not-allowed disabled:opacity-60",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-base font-medium text-fg">{s.name}</span>
                        {have !== undefined ? (
                          <Badge tone={have.state === "connected" ? "green" : "amber"} className="ml-auto">
                            {have.state === "connected" ? "Connected" : "Needs you"}
                          </Badge>
                        ) : !s.ready ? (
                          <Badge className="ml-auto">Coming next</Badge>
                        ) : null}
                      </span>
                      <span className="text-sm text-fg-muted text-pretty">{s.summary}</span>
                      {have?.account && (
                        <span className="min-w-0 truncate text-xs text-fg-faint">{have.account}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </DetailPane>
  );
}

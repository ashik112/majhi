import {
  type ConnectionType,
  type ConnectionView,
  type ConnectStatus,
  connectionType,
  GLOBAL_CONNECTIONS,
} from "@majhi/shared";
import { ArrowLeft, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { DetailPane } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useConnectStatus } from "@/lib/connect-queries";
import { useConnectionCommand, useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import { useSearchParam } from "@/pages/parts/url-state";
import { ConnectCatalog } from "./connect-catalog";
import { ConnectionDetail } from "./connection-detail";
import { connectionGroups, connectionStatus } from "./model";
import { NewConnection } from "./new-connection";
import { scopeName, WorkspaceTag } from "./scope-picker";
import { ServiceLogo, serviceOf } from "./service-logo";

/** Service-first setup, with one destination and one entry point. */
export function ConnectionsView() {
  const connections = useConnections();
  const orgs = useOrgs();
  const statuses = useConnectStatus();
  const now = useNow(30_000);
  const toast = useToast();
  const { org: orgFilter } = useOrgFilter();
  const [picked, setPicked] = useState<string>();
  const [linked, setLinked] = useSearchParam("connection");
  const [, setView] = useSearchParam("tab");
  const [mode, setMode] = useState<"connected" | "catalog" | "custom">();
  const [connecting, setConnecting] = useState(false);
  const [destination, setDestination] = useState<string>();
  const [customType, setCustomType] = useState<ConnectionType>("mcp");
  const [query, setQuery] = useState("");
  const test = useConnectionCommand("connections.test");
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const all = connections.data ?? [];
  const orgList = orgs.data ?? [];
  const visible = all.filter((c) =>
    `${c.name} ${c.description} ${connectionType(c.type).label}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selected = all.find((c) => c.id === (linked ?? picked));
  const catalog = mode === "catalog" || (mode === undefined && !selected && all.length === 0);
  const select = (id: string) => {
    setView(undefined);
    setMode("connected");
    setPicked(id);
    setLinked(id);
  };
  const browse = (org?: string) => {
    setView(undefined);
    setPicked(undefined);
    setLinked(undefined);
    setMode("catalog");
    setDestination(org ?? orgFilter);
  };
  const overview = () => {
    setView(undefined);
    setPicked(undefined);
    setLinked(undefined);
    setMode("connected");
  };
  const runTest = (view: ConnectionView) => {
    setTesting((prev) => new Set(prev).add(view.id));
    test.mutate(
      { id: view.id },
      {
        onError: (error) =>
          toast(`Could not test ${view.name}`, { detail: describeError(error), tone: "error" }),
        onSettled: () =>
          setTesting((prev) => {
            const next = new Set(prev);
            next.delete(view.id);
            return next;
          }),
      },
    );
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Connections"
        subtitle="Connect the services your agents work with."
        className="flex-wrap gap-y-3"
      >
        <Button variant="primary" onClick={() => browse()} disabled={connecting}>
          <Plus aria-hidden="true" />
          Connect a service
        </Button>
      </PageHeader>
      {connections.isError ? (
        <p role="alert" className="p-6 text-base text-red">
          Could not load connections: {describeError(connections.error)}
        </p>
      ) : connections.isPending || orgs.isPending ? (
        <DetailPane label="Loading connections">
          <div aria-busy="true" className="grid gap-3 pt-5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-32 rounded-lg" />
            ))}
          </div>
        </DetailPane>
      ) : orgs.isError ? (
        <p role="alert" className="p-6 text-base text-red">
          Could not load workspaces: {describeError(orgs.error)}
        </p>
      ) : (
        <>
          <nav aria-label="Connection views" className="mb-3 flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              aria-pressed={!catalog && mode !== "custom"}
              className={cn(!catalog && mode !== "custom" && "bg-selected text-fg")}
              onClick={overview}
              disabled={connecting}
            >
              Connected <span className="font-mono text-xs text-fg-muted">{all.length}</span>
            </Button>
            <Button
              variant="ghost"
              aria-pressed={catalog || mode === "custom"}
              className={cn((catalog || mode === "custom") && "bg-selected text-fg")}
              onClick={() => browse()}
              disabled={connecting}
            >
              Browse services
            </Button>
          </nav>
          {mode === "custom" ? (
            <NewConnection
              initialType={customType}
              orgs={orgList}
              defaultOrg={destination ?? orgFilter}
              onClose={() => setMode("catalog")}
              onCreated={select}
            />
          ) : catalog ? (
            <ConnectCatalog
              orgs={orgList}
              defaultOrg={destination ?? orgFilter}
              onOpen={select}
              onBusyChange={setConnecting}
              onCustom={(org, type) => {
                setDestination(org);
                setCustomType(type);
                setMode("custom");
              }}
            />
          ) : selected ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <Button variant="ghost" size="sm" className="shrink-0 self-start" onClick={overview}>
                <ArrowLeft aria-hidden="true" />
                All connections
              </Button>
              <ConnectionDetail
                key={selected.id}
                view={selected}
                orgs={orgList}
                testing={testing.has(selected.id)}
                now={now}
                onTest={() => runTest(selected)}
                onRemoved={overview}
              />
            </div>
          ) : (
            <DetailPane
              label="Connected services"
              head={
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-md font-semibold">{plural(visible.length, "connection")}</h2>
                  <Input
                    aria-label="Search connections"
                    type="search"
                    value={query}
                    placeholder="Search connections"
                    className="ml-auto w-[220px]"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              }
            >
              {all.length === 0 ? (
                <div className="flex max-w-[500px] flex-col items-start gap-3 py-8">
                  <h3 className="text-md font-semibold">Connect your first service</h3>
                  <p className="text-base text-fg-muted">
                    Choose the workspace, then the service, then sign in.
                  </p>
                  <Button variant="primary" onClick={() => browse()}>
                    Browse services
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-6 pt-4">
                  {connectionGroups(visible, orgList, orgFilter).map((group) => (
                    <section key={group.org} aria-label={scopeName(group.org, orgList)}>
                      <div className="flex items-center gap-2 border-b border-line pb-2">
                        <WorkspaceTag org={group.org} orgs={orgList} className="text-base font-semibold" />
                        <span className="font-mono text-sm text-fg-faint tabular-nums">
                          {group.items.length}
                        </span>
                        <span className="text-sm text-fg-faint">
                          {group.org === GLOBAL_CONNECTIONS ? "· every workspace" : ""}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          onClick={() => browse(group.org)}
                          aria-label={`Connect a service to ${scopeName(group.org, orgList)}`}
                        >
                          <Plus aria-hidden="true" />
                          Connect
                        </Button>
                      </div>
                      {group.items.length === 0 ? (
                        <p className="py-3 text-sm text-fg-faint">
                          {query.trim() === "" ? "No connections yet." : "None match the search."}
                        </p>
                      ) : (
                        <ul
                          aria-label={`${scopeName(group.org, orgList)} connections`}
                          className="divide-y divide-line"
                        >
                          {group.items.map((view) => (
                            <ConnectionRow
                              key={view.id}
                              view={view}
                              signed={statuses.data?.find((s) => s.connection === view.id)}
                              testing={testing.has(view.id)}
                              onOpen={() => select(view.id)}
                              onTest={() => runTest(view)}
                            />
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
              )}
            </DetailPane>
          )}
        </>
      )}
    </div>
  );
}

/** One saved connection: its service, account, who gets it, and how its last check went. */
function ConnectionRow({
  view,
  signed,
  testing,
  onOpen,
  onTest,
}: {
  view: ConnectionView;
  signed: ConnectStatus | undefined;
  testing: boolean;
  onOpen: () => void;
  onTest: () => void;
}) {
  const status = connectionStatus(view, testing);
  const needsSignIn = signed !== undefined && signed.state !== "connected";
  const lamp = needsSignIn
    ? "needs"
    : signed?.state === "connected" && !testing && view.lastTest?.ok !== false
      ? "done"
      : status.lamp;
  const label = needsSignIn
    ? "Reconnect"
    : signed?.state === "connected" && lamp === "done"
      ? "Connected"
      : status.label;
  return (
    <li className="relative flex flex-wrap items-center gap-x-4 gap-y-2 py-3 sm:flex-nowrap">
      <ServiceLogo service={signed?.service ?? serviceOf(view)} type={view.type} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          className="cursor-pointer text-left text-base font-semibold text-fg after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent"
        >
          {view.name}
        </button>
        <p className="truncate text-sm text-fg-muted">
          {signed?.account ?? (view.description || connectionType(view.type).label)}
        </p>
      </div>
      <span
        className={cn("shrink-0 text-sm", view.agents.length === 0 ? "text-amber" : "text-fg-muted")}
        title={view.agents.map((a) => `@${a}`).join(", ")}
      >
        {view.agents.length === 0 ? "No agents" : plural(view.agents.length, "agent")}
      </span>
      <span className={cn("flex w-[110px] shrink-0 items-center gap-2 text-sm", LAMP_TEXT[lamp])}>
        <Lamp state={lamp} size={7} />
        {label}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="relative z-10"
        disabled={testing}
        onClick={onTest}
        aria-label={`Test ${view.name}`}
      >
        {testing ? "Testing" : "Test"}
      </Button>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-faint" />
    </li>
  );
}

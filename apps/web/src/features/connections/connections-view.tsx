import { type ConnectionType, type ConnectionView, connectionType, GLOBAL_CONNECTIONS } from "@majhi/shared";
import { ArrowLeft, ChevronRight, Globe, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { DetailPane } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
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
import { connectionStatus } from "./model";
import { NewConnection } from "./new-connection";
import { scopeName } from "./scope-picker";
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
  const [mode, setMode] = useState<"connected" | "catalog" | "custom">();
  const [connecting, setConnecting] = useState(false);
  const [destination, setDestination] = useState<string>();
  const [customType, setCustomType] = useState<ConnectionType>("mcp");
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<string>();
  const test = useConnectionCommand("connections.test");
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const all = connections.data ?? [];
  const orgList = orgs.data ?? [];
  const filter = scopeFilter ?? orgFilter ?? "all";
  const visible = all.filter(
    (c) =>
      (filter === "all" ||
        c.org === filter ||
        (filter !== GLOBAL_CONNECTIONS && c.org === GLOBAL_CONNECTIONS)) &&
      `${c.name} ${c.description} ${connectionType(c.type).label}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const selected = all.find((c) => c.id === (linked ?? picked));
  const catalog = mode === "catalog" || (mode === undefined && !selected && all.length === 0);
  const select = (id: string) => {
    setMode("connected");
    setPicked(id);
    setLinked(id);
  };
  const browse = () => {
    setPicked(undefined);
    setLinked(undefined);
    setMode("catalog");
    setDestination(orgFilter);
  };
  const overview = () => {
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
        <Button variant="primary" onClick={browse} disabled={connecting}>
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
              onClick={browse}
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
                  <div className="ml-auto flex flex-wrap gap-2">
                    <Input
                      aria-label="Search connections"
                      type="search"
                      value={query}
                      placeholder="Search connections"
                      className="w-[200px]"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <Select
                      aria-label="Filter connection scope"
                      className="w-[200px]"
                      value={filter}
                      onChange={(event) => setScopeFilter(event.target.value)}
                    >
                      <option value="all">All scopes</option>
                      <option value={GLOBAL_CONNECTIONS}>Global</option>
                      {orgList.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              }
            >
              {visible.length === 0 ? (
                <div className="flex max-w-[500px] flex-col items-start gap-3 py-8">
                  <h3 className="text-md font-semibold">
                    {all.length === 0 ? "Connect your first service" : "No matching connections"}
                  </h3>
                  <p className="text-base text-fg-muted">
                    {all.length === 0
                      ? "Choose a service, choose who can use it, then sign in."
                      : "Try another search or scope, or connect a service."}
                  </p>
                  <Button variant="primary" onClick={browse}>
                    Browse services
                  </Button>
                </div>
              ) : (
                <ul aria-label="Connected services" className="divide-y divide-line pt-2">
                  {visible.map((view) => {
                    const signed = statuses.data?.find((s) => s.connection === view.id);
                    const status = connectionStatus(view, testing.has(view.id));
                    const needsSignIn = signed !== undefined && signed.state !== "connected";
                    const lamp = needsSignIn
                      ? "needs"
                      : signed?.state === "connected" && !testing.has(view.id) && view.lastTest?.ok !== false
                        ? "done"
                        : status.lamp;
                    const label = needsSignIn
                      ? "Reconnect"
                      : signed?.state === "connected" && lamp === "done"
                        ? "Connected"
                        : status.label;
                    return (
                      <li
                        key={view.id}
                        className="relative flex flex-wrap items-center gap-x-4 gap-y-2 py-4 sm:flex-nowrap"
                      >
                        <ServiceLogo service={signed?.service ?? serviceOf(view)} type={view.type} />
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={() => select(view.id)}
                            className="cursor-pointer text-left text-base font-semibold text-fg after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent"
                          >
                            {view.name}
                          </button>
                          <p className="truncate text-sm text-fg-muted">
                            {signed?.account ?? (view.description || connectionType(view.type).label)}
                          </p>
                        </div>
                        <span
                          className="flex max-w-[200px] items-center gap-1.5 truncate text-sm text-fg-muted"
                          title={
                            view.org === GLOBAL_CONNECTIONS
                              ? "Shared with all workspaces"
                              : scopeName(view.org, orgList)
                          }
                        >
                          {view.org === GLOBAL_CONNECTIONS && (
                            <Globe aria-hidden="true" className="size-3.5 shrink-0" />
                          )}
                          {scopeName(view.org, orgList)}
                        </span>
                        <span
                          className={cn(
                            "flex w-[100px] shrink-0 items-center gap-2 text-sm",
                            LAMP_TEXT[lamp],
                          )}
                        >
                          <Lamp state={lamp} size={7} />
                          {label}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="relative z-10"
                          disabled={testing.has(view.id)}
                          onClick={() => runTest(view)}
                          aria-label={`Test ${view.name}`}
                        >
                          {testing.has(view.id) ? "Testing" : "Test"}
                        </Button>
                        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-faint" />
                      </li>
                    );
                  })}
                </ul>
              )}
            </DetailPane>
          )}
        </>
      )}
    </div>
  );
}

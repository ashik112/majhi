import { type ConnectionView, connectionType, GLOBAL_CONNECTIONS, type OrgView } from "@majhi/shared";
import { ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useConnectionCommand, useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import { useSearchParam } from "@/pages/parts/url-state";
import { AddDialog } from "./add-dialog";
import { GROUPS, groupOfConnection, METHOD_WORD, type MethodGroup } from "./catalog";
import { ConnectionPanel } from "./connection-detail";
import { scopeName, WorkspaceMark } from "./scope-picker";
import { ServiceLogo, serviceOf } from "./service-logo";
import { needsOwner, type RowStatus, rowStatus } from "./status";

/** The columns every row shares, so lamps, workspaces and actions line up down the page. */
const COLUMNS =
  "grid-cols-[32px_minmax(120px,1fr)_24px_minmax(220px,1.6fr)_88px_16px] min-[1320px]:grid-cols-[32px_minmax(200px,1fr)_minmax(0,160px)_minmax(220px,320px)_72px_96px_16px]";

/**
 * Every connection in one list, grouped by how it connects. Each row is one line: what it is, who
 * has it, its one status and the one thing to do next. A side panel opens the rest.
 */
export function ConnectionsView() {
  const connections = useConnections();
  const orgs = useOrgs();
  const now = useNow(30_000);
  const toast = useToast();
  const { org: orgFilter } = useOrgFilter();
  const [linked, setLinked] = useSearchParam("connection");
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const check = useConnectionCommand("connections.test");
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const all = connections.data ?? [];
  const orgList = orgs.data ?? [];
  const inScope = all.filter(
    (c) => orgFilter === undefined || c.org === orgFilter || c.org === GLOBAL_CONNECTIONS,
  );
  const visible = inScope.filter((c) =>
    `${c.name} ${c.description} ${c.fields.host?.value ?? ""} ${c.health && "account" in c.health ? (c.health.account ?? "") : ""} ${connectionType(c.type).label}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selected = all.find((c) => c.id === linked);
  const working = all.filter((c) => c.health?.state === "connected").length;
  const attention = needsOwner(all);

  const runCheck = (view: ConnectionView) => {
    setChecking((prev) => new Set(prev).add(view.id));
    check.mutate(
      { id: view.id },
      {
        onError: (error) =>
          toast(`Could not check ${view.name}`, { detail: describeError(error), tone: "error" }),
        onSettled: () =>
          setChecking((prev) => {
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
        subtitle={
          all.length === 0
            ? "Connect the services your agents work with."
            : `${working} of ${plural(all.length, "connection")} verified${attention > 0 ? `, ${attention} need${attention === 1 ? "s" : ""} you` : ""}`
        }
        className="flex-wrap gap-y-3"
      >
        {all.length > 0 && (
          <Button variant="ghost" disabled={checking.size > 0} onClick={() => visible.forEach(runCheck)}>
            Check all
          </Button>
        )}
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          Add connection
        </Button>
      </PageHeader>
      {connections.isError ? (
        <p role="alert" className="p-6 text-base text-red">
          Could not load connections: {describeError(connections.error)}
        </p>
      ) : orgs.isError ? (
        <p role="alert" className="p-6 text-base text-red">
          Could not load workspaces: {describeError(orgs.error)}
        </p>
      ) : connections.isPending || orgs.isPending ? (
        <section
          aria-label="Loading connections"
          aria-busy="true"
          className={cn("flex flex-col gap-2 rounded-2xl p-4", GLASS)}
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </section>
      ) : inScope.length === 0 ? (
        <Empty filtered={all.length > 0} onAdd={() => setAdding(true)} />
      ) : (
        <section
          aria-label="Connections"
          className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl", GLASS)}
        >
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3">
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
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-8 scroll-fade">
            {visible.length === 0 ? (
              <p className="px-2 py-6 text-base text-fg-muted">None match the search.</p>
            ) : (
              GROUPS.map((group) => {
                const items = visible.filter((c) => groupOfConnection(c) === group.id);
                return items.length === 0 ? null : (
                  <Group
                    key={group.id}
                    id={group.id}
                    title={group.title}
                    blurb={group.blurb}
                    count={items.length}
                  >
                    {items.map((view) => (
                      <Row
                        key={view.id}
                        view={view}
                        orgs={orgList}
                        now={now}
                        checking={checking.has(view.id)}
                        onOpen={() => setLinked(view.id)}
                        onCheck={() => runCheck(view)}
                      />
                    ))}
                  </Group>
                );
              })
            )}
          </div>
        </section>
      )}
      {selected !== undefined && (
        <ConnectionPanel
          key={selected.id}
          view={selected}
          orgs={orgList}
          checking={checking.has(selected.id)}
          now={now}
          onCheck={() => runCheck(selected)}
          onClose={() => setLinked(undefined)}
          onRemoved={() => setLinked(undefined)}
        />
      )}
      {adding && (
        <AddDialog
          orgs={orgList}
          defaultOrg={orgFilter}
          onClose={() => setAdding(false)}
          onOpen={(id) => {
            setAdding(false);
            setLinked(id);
          }}
        />
      )}
    </div>
  );
}

function Group({
  id,
  title,
  blurb,
  count,
  children,
}: {
  id: MethodGroup;
  title: string;
  blurb: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} data-group={id} className="pt-4">
      <div className="flex items-baseline gap-3 px-2 pb-1.5">
        <h3 className="text-xs font-medium tracking-[0.08em] text-fg-faint uppercase">{title}</h3>
        <span className="font-mono text-xs text-fg-faint tabular-nums">{count}</span>
        <p className="hidden min-w-0 truncate text-xs text-fg-faint min-[1320px]:block">{blurb}</p>
      </div>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

/** One connection on one line. */
function Row({
  view,
  orgs,
  now,
  checking,
  onOpen,
  onCheck,
}: {
  view: ConnectionView;
  orgs: readonly OrgView[];
  now: number;
  checking: boolean;
  onOpen: () => void;
  onCheck: () => void;
}) {
  const status = rowStatus(view, checking, now);
  const account = view.health !== undefined && "account" in view.health ? view.health.account : undefined;
  const host = view.fields.host?.value;
  const sub = [account, host, connectionType(view.type).label].filter((v) => v !== undefined && v !== "")[0];
  return (
    <li
      className={cn(
        "relative grid items-center gap-x-3 rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-raised",
        COLUMNS,
      )}
    >
      <ServiceLogo service={serviceOf(view)} type={view.type} className="size-8" />
      <div className="min-w-0">
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-full cursor-pointer truncate text-left text-base font-semibold text-fg after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent"
        >
          {view.name}
        </button>
        <p className="truncate text-sm text-fg-muted" title={[account, host].filter(Boolean).join(" · ")}>
          {host !== undefined && account !== undefined ? `${account} · ${host}` : sub}
          {view.type !== "chat" && (
            <span className={cn("min-[1320px]:hidden", view.agents.length === 0 && "text-amber")}>
              {" · "}
              {view.agents.length === 0 ? "no agents" : plural(view.agents.length, "agent")}
            </span>
          )}
        </p>
      </div>
      <span
        className="flex min-w-0 items-center gap-2 text-sm text-fg-soft"
        title={scopeName(view.org, orgs)}
      >
        <WorkspaceMark org={view.org} orgs={orgs} size="sm" />
        <span className="hidden min-w-0 truncate min-[1320px]:block">{scopeName(view.org, orgs)}</span>
      </span>
      <StatusCell status={status} />
      <span
        className={cn(
          "hidden truncate text-sm min-[1320px]:block",
          view.agents.length === 0 && view.type !== "chat" ? "text-amber" : "text-fg-muted",
        )}
        title={view.agents.map((a) => `@${a}`).join(", ")}
      >
        {view.type === "chat"
          ? ""
          : view.agents.length === 0
            ? "No agents"
            : plural(view.agents.length, "agent")}
      </span>
      <RowAction view={view} status={status} checking={checking} onOpen={onOpen} onCheck={onCheck} />
      <ChevronRight aria-hidden="true" className="size-4 text-fg-faint" />
    </li>
  );
}

/** The lamp, its word and one line of why. The words are in the title for a line that is cut. */
function StatusCell({ status }: { status: RowStatus }) {
  return (
    <span
      className={cn("flex min-w-0 items-start gap-2 text-sm", LAMP_TEXT[status.lamp])}
      title={`${status.word}: ${status.line}`}
    >
      <Lamp state={status.lamp} size={7} className="mt-[7px]" />
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">{status.word}</span>
        <span className="line-clamp-2 text-pretty text-fg-faint">{status.line}</span>
      </span>
    </span>
  );
}

function RowAction({
  view,
  status,
  checking,
  onOpen,
  onCheck,
}: {
  view: ConnectionView;
  status: RowStatus;
  checking: boolean;
  onOpen: () => void;
  onCheck: () => void;
}) {
  if (status.action === "none") return <span aria-hidden="true" />;
  const primary = status.action === "fix" || status.action === "reconnect";
  return (
    <Button
      size="sm"
      variant={primary ? "primary" : "ghost"}
      className="relative z-10 w-full"
      disabled={checking}
      onClick={primary ? onOpen : onCheck}
      aria-label={`${status.actionLabel} ${view.name}`}
    >
      {checking ? "Checking" : status.actionLabel}
    </Button>
  );
}

/** Nothing connected yet: the four ways to connect, and one button. */
function Empty({ filtered, onAdd }: { filtered: boolean; onAdd: () => void }) {
  return (
    <section
      aria-label="No connections"
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto rounded-2xl p-8 text-center",
        GLASS,
      )}
    >
      <div className="flex max-w-[520px] flex-col items-center gap-2">
        <h2 className="text-lg font-semibold">
          {filtered ? "Nothing connected for this workspace" : "Connect your first service"}
        </h2>
        <p className="text-base text-fg-muted text-pretty">
          Every connection is checked with a real call before it says connected, and again every few hours.
        </p>
      </div>
      <ul className="grid w-full max-w-[760px] gap-2.5 sm:grid-cols-2">
        {GROUPS.filter((g) => g.id !== "own" && g.id !== "chat").map((g) => (
          <li
            key={g.id}
            className="flex flex-col gap-0.5 rounded-xl border border-line-strong bg-card p-3 text-left"
          >
            <span className="text-base font-semibold text-fg">{g.title}</span>
            <span className="text-sm text-fg-muted">{g.blurb}</span>
            <span className="text-xs text-fg-faint">{METHOD_WORD[g.id]}</span>
          </li>
        ))}
      </ul>
      <Button variant="primary" size="lg" onClick={onAdd}>
        <Plus aria-hidden="true" />
        Add connection
      </Button>
    </section>
  );
}

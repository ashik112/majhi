import { type ConnectionView, connectionType, type OrgView } from "@majhi/shared";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { DetailPane, ListDetail, ListPane, ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { orgLabel } from "@/features/accounts/model";
import { cn } from "@/lib/cn";
import { useConnectionCommand, useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { badgeLetters, plural } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import { useSearchParam } from "@/pages/parts/url-state";
import { ConnectionDetail } from "./connection-detail";
import { connectionGroups, connectionStatus } from "./model";
import { NewConnection } from "./new-connection";

/** Connections by org on the left, each with its last Test; the picked one on the right. */
export function ConnectionsView() {
  const connections = useConnections();
  const orgs = useOrgs();
  const now = useNow(30_000);
  const toast = useToast();
  const { org: orgFilter } = useOrgFilter();
  const [picked, setPicked] = useState<string | undefined>();
  const [linked, setLinked] = useSearchParam("connection");
  /** The org a new connection goes to, while the form is open. `""` lets the form pick. */
  const [adding, setAdding] = useState<string>();
  const test = useConnectionCommand("connections.test");
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());

  const all = connections.data ?? [];
  const orgList = orgs.data ?? [];
  const groups = connectionGroups(all, orgList, orgFilter);
  const first = groups.find((g) => g.items[0])?.items[0];
  const selected = all.find((c) => c.id === (linked ?? picked)) ?? first;
  const select = (id: string) => {
    setAdding(undefined);
    setPicked(id);
    if (linked !== undefined) setLinked(undefined);
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
        subtitle={
          connections.isPending
            ? "Loading connections"
            : `${plural(all.length, "connection")}. Clusters, MCP servers, hosts, keys, mailboxes and browsers agents can reach.`
        }
      />
      {connections.isError ? (
        <p role="alert" className="p-8 text-base text-red">
          Could not load connections: {describeError(connections.error)}
        </p>
      ) : (
        <ListDetail>
          <ListPane
            label="Connections"
            className="min-[1100px]:w-[300px] min-[1320px]:w-[336px]"
            footer={
              <Button
                variant="ghost"
                aria-pressed={adding !== undefined}
                className={cn("w-full justify-start", adding !== undefined && ROW_SELECTED)}
                onClick={() => setAdding(orgFilter ?? "")}
              >
                <Plus aria-hidden="true" />
                New connection
              </Button>
            }
          >
            {connections.isPending ? (
              <div aria-busy="true" className="flex flex-col gap-2 p-1">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 rounded-md" />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {groups.map((group) => {
                  const label = orgLabel(group.org, orgList).name;
                  return (
                    <ConnectionGroup
                      key={group.org}
                      label={label}
                      org={orgList.find((o) => o.id === group.org)}
                      count={group.items.length}
                      creating={adding === group.org}
                      onAdd={() => setAdding(group.org)}
                    >
                      {group.items.length === 0 ? (
                        <p className="px-2 pb-1 text-sm text-fg-faint">No connections yet.</p>
                      ) : (
                        <ul aria-label={`Connections of ${label}`} className="flex flex-col gap-px">
                          {group.items.map((view) => (
                            <ConnectionRow
                              key={view.id}
                              view={view}
                              testing={testing.has(view.id)}
                              selected={adding === undefined && selected?.id === view.id}
                              onSelect={() => select(view.id)}
                              onTest={() => runTest(view)}
                            />
                          ))}
                        </ul>
                      )}
                    </ConnectionGroup>
                  );
                })}
              </div>
            )}
          </ListPane>

          {adding !== undefined ? (
            <NewConnection
              key={adding}
              orgs={orgList}
              defaultOrg={adding === "" ? orgFilter : adding}
              onClose={() => setAdding(undefined)}
              onCreated={(id) => select(id)}
            />
          ) : selected ? (
            <ConnectionDetail
              key={selected.id}
              view={selected}
              orgs={orgList}
              testing={testing.has(selected.id)}
              now={now}
              onTest={() => runTest(selected)}
              onRemoved={() => {
                setPicked(undefined);
                setLinked(undefined);
              }}
            />
          ) : connections.isPending ? (
            <DetailPane label="Loading">
              <Skeleton className="mt-5 h-40 rounded-lg" />
            </DetailPane>
          ) : (
            <DetailPane label="No connections">
              <div className="flex max-w-[480px] flex-col items-start gap-3 pt-6">
                <h2 className="text-md font-semibold">No connections yet</h2>
                <p className="text-base text-fg-muted text-pretty">
                  Add a cluster, an MCP server like New Relic, an SSH host, API keys, a mailbox or a browser.
                  Agents of the org can then debug and report with it, and every change they make asks you
                  first.
                </p>
                <Button variant="primary" onClick={() => setAdding(orgFilter ?? "")}>
                  New connection
                </Button>
              </div>
            </DetailPane>
          )}
        </ListDetail>
      )}
    </div>
  );
}

function ConnectionGroup({
  label,
  org,
  count,
  creating,
  onAdd,
  children,
}: {
  label: string;
  org: OrgView | undefined;
  count: number;
  creating: boolean;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-px">
      <div className="flex h-8 items-center gap-2 pr-0.5 pl-2">
        <OrgBadge label={badgeLetters(org?.key ?? label)} color={org?.color} size="xs" />
        <h2 className="min-w-0 truncate text-sm font-medium text-fg-soft">{label}</h2>
        <span className="tnum font-mono text-xs text-fg-faint">{count}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`New connection in ${label}`}
          aria-pressed={creating}
          title={`New connection in ${label}`}
          className={cn("ml-auto", creating && "bg-selected text-fg")}
          onClick={onAdd}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      {children}
    </section>
  );
}

/**
 * Two lines: the name with its Test button, then the lamp and word of the last Test, the type and the
 * description. The name is the button that picks it; it covers the row, under the Test button.
 */
function ConnectionRow({
  view,
  testing,
  selected,
  onSelect,
  onTest,
}: {
  view: ConnectionView;
  testing: boolean;
  selected: boolean;
  onSelect: () => void;
  onTest: () => void;
}) {
  const status = connectionStatus(view, testing);
  return (
    <li
      className={cn(
        ROW,
        "min-h-[50px] flex-col justify-center gap-0.5 py-1.5 pr-1.5 pl-2.5 focus-within:bg-raised",
        selected && ROW_SELECTED,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          onClick={onSelect}
          title={view.description || view.name}
          className={cn(
            "min-w-0 cursor-pointer truncate text-left text-sm after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent",
            selected ? "text-fg" : "text-fg-soft",
          )}
        >
          {view.name}
        </button>
        <Button
          size="sm"
          variant="ghost"
          className="relative z-10 ml-auto h-6 px-2"
          disabled={testing}
          onClick={onTest}
          aria-label={`Test ${view.name}`}
        >
          Test
        </Button>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <Lamp state={status.lamp} size={7} />
        <span className={cn("shrink-0", LAMP_TEXT[status.lamp])}>{status.label}</span>
        <span aria-hidden="true" className="text-fg-dim">
          ·
        </span>
        <span className="shrink-0 text-fg-faint">{connectionType(view.type).label}</span>
        {view.description && (
          <>
            <span aria-hidden="true" className="text-fg-dim">
              ·
            </span>
            <span className="min-w-0 truncate text-fg-muted">{view.description}</span>
          </>
        )}
      </span>
    </li>
  );
}

import {
  type Diagram,
  type DiagramNode,
  type MapEdge,
  type MapNode,
  type OrgView,
  PRIVATE,
} from "@majhi/shared";
import { Loader, RefreshCw, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { WorkspaceMark } from "@/features/connections/scope-picker";
import type { EdgeDecor, NodeDecor, Selection } from "@/features/diagram/diagram-canvas";
import { LazyScene, preloadScene } from "@/features/diagram/lazy-scene";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useMap, useMapEstimate, useUpdateMap } from "@/lib/map-queries";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import {
  agoWords,
  edgeInView,
  KIND_LABEL,
  KIND_TONE,
  lampOf,
  MAP_VIEWS,
  type MapViewId,
  mergesWords,
  nodeInView,
  tasksOf,
  usdWords,
} from "./model";
import { MapPanel } from "./panel";

const LEGEND = ["http", "queue", "data", "lib"] as const;

const LAST_KEY = "majhi.map.workspace";

function readLast(): string | undefined {
  try {
    return localStorage.getItem(LAST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberLast(org: string): void {
  try {
    localStorage.setItem(LAST_KEY, org);
  } catch {
    // Storage blocked: the page opens on the first workspace next time.
  }
}

/**
 * The Map page. It always shows one workspace: the one picked on this page, else the sidebar's, else
 * the one last shown here, else the first. Its picker is the page's own and leaves the sidebar alone.
 */
export function MapScreen() {
  useEffect(preloadScene, []);
  const { org: picked } = useOrgFilter();
  const orgs = useOrgs().data;
  // The page's own choice: it never changes the sidebar's workspace. A new sidebar pick resets it.
  const [chosen, setChosen] = useState<string | undefined>();
  const [seen, setSeen] = useState(picked);
  if (seen !== picked) {
    setSeen(picked);
    setChosen(undefined);
  }
  if (orgs === undefined) return <Header />;
  const known = (id: string | undefined) => id !== undefined && orgs.some((o) => o.id === id);
  const org = [chosen, picked, readLast()].find((id): id is string => known(id)) ?? orgs[0]?.id ?? PRIVATE;
  const choose = (id: string) => {
    rememberLast(id);
    setChosen(id);
  };
  return (
    <MapFor
      key={org}
      org={org}
      name={orgs.find((o) => o.id === org)?.name ?? org}
      switcher={<WorkspaceChips orgs={orgs} value={org} onChange={choose} />}
    />
  );
}

/** Which workspace the map shows: its tile, then a compact picker. */
function WorkspaceChips({
  orgs,
  value,
  onChange,
}: {
  orgs: readonly OrgView[];
  value: string;
  onChange: (org: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <WorkspaceMark org={value} orgs={orgs} size="sm" />
      <Select
        aria-label="Workspace"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-[140px] text-sm"
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header
      className={cn(
        "mb-3 flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 rounded-2xl px-4 py-2",
        GLASS,
      )}
    >
      <h1 className="text-md leading-5 font-semibold text-fg">Map</h1>
      {children}
    </header>
  );
}

function MapFor({ org, name, switcher }: { org: string; name: string; switcher: React.ReactNode }) {
  const map = useMap(org);
  const estimate = useMapEstimate(org);
  const update = useUpdateMap(org);
  const now = useNow(30_000);
  const [viewId, setViewId] = useState<MapViewId>("all");
  const [selection, setSelection] = useState<Selection>();
  const data = map.data;

  const changed = useMemo(() => new Set(data?.changedThisWeek ?? []), [data?.changedThisWeek]);
  const nodes = data?.map.nodes;
  const lines = data?.map.edges;

  const diagram = useMemo<Diagram>(() => {
    const boxes: readonly MapNode[] = nodes ?? [];
    const all: readonly MapEdge[] = lines ?? [];
    // "Together" lines are weak: shown on Everything and on what changed, never in the way of the flow.
    const shown = all.filter((e) => e.type !== "together" || viewId === "all" || viewId === "changed");
    const byDeploy = viewId === "deploy";
    const frames = byDeploy
      ? [...new Set(boxes.map((n) => n.deploy ?? "not known"))].map(
          (target): DiagramNode => ({ id: `deploy:${target}`, label: target }),
        )
      : [];
    return {
      layout: "top-down",
      nodes: [
        ...frames,
        ...boxes.map(
          (n): DiagramNode => ({
            id: n.id,
            label: n.label,
            ...(n.sub === undefined ? {} : { sub: n.sub }),
            kind: KIND_LABEL[n.kind],
            tone: KIND_TONE[n.kind],
            ...(byDeploy ? { group: `deploy:${n.deploy ?? "not known"}` } : {}),
          }),
        ),
      ],
      edges: shown,
    };
  }, [nodes, lines, viewId]);

  const byId = useMemo(() => new Map((nodes ?? []).map((n) => [n.id, n])), [nodes]);
  const byKey = useMemo(() => new Map((lines ?? []).map((e) => [e.id, e])), [lines]);

  const nodeDecor = useMemo(() => {
    if (data === undefined) return undefined;
    return (n: DiagramNode): NodeDecor => {
      const box = byId.get(n.id);
      if (box === undefined) return {};
      const lamp = lampOf(tasksOf(data, box));
      return {
        dim: !nodeInView(viewId, box, data.map.edges, changed),
        ...(lamp === undefined ? {} : { lamp }),
        ...(viewId === "changed" && changed.has(box.id) ? { tag: "CHANGED" } : {}),
        ...(viewId === "deploy" && box.deploy !== undefined ? { caption: box.deploy } : {}),
      };
    };
  }, [data, byId, viewId, changed]);

  const edgeDecor = useMemo(() => {
    return (key: string): EdgeDecor => {
      const e = byKey.get(key);
      if (e === undefined) return {};
      const inView = edgeInView(viewId, e, changed);
      return {
        dim: !inView,
        ...(e.state === "new" ? { badge: "NEW" } : {}),
        ...(!inView && viewId !== "all" ? { hideLabel: true } : {}),
      };
    };
  }, [byKey, viewId, changed]);

  const running = data?.running;
  const usd = estimate.data?.usd;
  const ago = data?.updatedAt === undefined ? undefined : agoWords(data.updatedAt, now);
  const failed = data?.failed ?? (update.error === null ? undefined : update.error.message);

  if (map.isError && data === undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Header>{switcher}</Header>
        <Problem icon={<Waypoints />} title="Could not load the map" body={describeError(map.error)} />
      </div>
    );
  }

  const empty = data !== undefined && data.map.nodes.length === 0;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Header>
        {switcher}
        <span aria-hidden="true" className="h-5 w-px bg-line-strong" />
        <Segmented
          label="View"
          value={viewId}
          onChange={setViewId}
          segments={MAP_VIEWS.map((v) => ({ value: v.id, label: v.label }))}
        />
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <span className="min-w-0 truncate text-sm text-fg-muted" data-map-fresh="">
            {ago === undefined ? `${name}: never updated` : `Updated ${ago}`}
            {data !== undefined && ago !== undefined && (
              <>
                {" · "}
                <span className={data.mergesSince > 0 ? "font-medium text-accent-text" : undefined}>
                  {mergesWords(data.mergesSince)}
                </span>
              </>
            )}
          </span>
          <Button
            variant="primary"
            disabled={running !== undefined || update.isPending || data === undefined}
            onClick={() => update.mutate("")}
            title={estimate.data?.note}
          >
            {running === undefined ? (
              <RefreshCw aria-hidden="true" />
            ) : (
              <Loader aria-hidden="true" className="animate-spin" />
            )}
            Update map
            {usd !== undefined && <span className="font-normal opacity-75">{usdWords(usd)}</span>}
          </Button>
        </div>
      </Header>
      <div className="flex min-h-0 flex-1 gap-3">
        <section
          aria-label="Map"
          className={cn("relative min-w-0 flex-1 overflow-hidden rounded-2xl", GLASS)}
        >
          {running !== undefined && (
            <div
              role="status"
              className="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-accent-line bg-glass-strong px-3 py-1.5 text-sm text-fg shadow-pop"
            >
              <Loader aria-hidden="true" className="size-3.5 animate-spin text-accent-text" />
              {running.text}
            </div>
          )}
          {empty ? (
            <div className="grid h-full place-items-center p-6">
              <div className="flex max-w-[420px] flex-col items-start gap-3">
                <h2 className="text-md font-semibold text-fg">No map yet</h2>
                <p className="text-base text-fg-muted">
                  {data.projects.length === 0
                    ? `${name} has no projects on this computer. Register one on Projects and links, then update the map.`
                    : `Update the map to read the ${data.projects.length} ${data.projects.length === 1 ? "project" : "projects"} of ${name} and draw how they connect.`}
                </p>
                {data.projects.length > 0 && (
                  <Button
                    variant="primary"
                    disabled={running !== undefined}
                    onClick={() => update.mutate("")}
                  >
                    Update map
                  </Button>
                )}
              </div>
            </div>
          ) : data === undefined ? (
            <div
              role="status"
              aria-busy="true"
              className="grid h-full place-items-center text-sm text-fg-faint"
            >
              Reading the map
            </div>
          ) : (
            <LazyScene
              diagram={diagram}
              node={nodeDecor}
              edge={edgeDecor}
              selection={selection}
              onSelect={setSelection}
              legend={LEGEND}
            />
          )}
          {failed !== undefined && (
            <p
              role="alert"
              className="absolute right-3 bottom-3 z-20 max-w-[420px] rounded-md border border-red-line bg-glass-strong px-3 py-1.5 text-sm text-red"
            >
              {failed}
            </p>
          )}
          {data?.report?.note !== undefined && running === undefined && (
            <p
              className="absolute right-3 bottom-3 z-10 max-w-[420px] rounded-md border border-line-strong bg-glass-strong px-3 py-1.5 text-sm text-fg-muted"
              hidden={failed !== undefined}
            >
              {data.report.note}
            </p>
          )}
        </section>
        {data !== undefined && !empty && (
          <MapPanel view={data} selection={selection} onSelect={setSelection} />
        )}
      </div>
    </div>
  );
}

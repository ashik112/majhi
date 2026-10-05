import { MAP_EDGE_LABEL, type MapEdge, type MapNode, type MapView } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { OpenInEditor } from "@/components/open-in-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { SectionLabel } from "@/components/ui/section-label";
import type { Selection } from "@/features/diagram/diagram-canvas";
import { EDGE_PRESETS } from "@/features/diagram/presets";
import { useNewTask } from "@/features/new-task/new-task-context";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { useConfirmEdge, useRemoveEdge } from "@/lib/map-queries";
import type { AppSearch } from "@/router";
import { KIND_LABEL, lampOf, tasksOf } from "./model";

const TASK_LAMP = { running: "working", review: "needs", paused: "needs", mr: "needs" } as const;

/** The right side: a box (who it talks to, who uses it, its open tasks) or a line (its proof). */
export function MapPanel({
  view,
  selection,
  onSelect,
}: {
  view: MapView;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const node = selection?.kind === "node" ? view.map.nodes.find((n) => n.id === selection.id) : undefined;
  const edge = selection?.kind === "edge" ? view.map.edges.find((e) => e.id === selection.id) : undefined;
  return (
    <aside
      aria-label="Map details"
      className={cn(
        "flex w-[300px] shrink-0 flex-col gap-4 min-[1320px]:w-[330px] overflow-y-auto overscroll-contain rounded-2xl p-4 scroll-fade",
        GLASS,
      )}
    >
      {node !== undefined ? (
        <NodePanel view={view} node={node} onSelect={onSelect} />
      ) : edge !== undefined ? (
        <EdgePanel view={view} edge={edge} onSelect={onSelect} />
      ) : (
        <p className="text-base text-fg-muted">
          Click a box to see what it talks to and what uses it. Click a line to see the proof.
        </p>
      )}
    </aside>
  );
}

function labelOf(view: MapView, id: string): string {
  return view.map.nodes.find((n) => n.id === id)?.label ?? id;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </div>
  );
}

const ROW =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-base text-fg-soft hover:bg-raised";

function NodePanel({
  view,
  node,
  onSelect,
}: {
  view: MapView;
  node: MapNode;
  onSelect: (selection: Selection) => void;
}) {
  const navigate = useNavigate();
  const newTask = useNewTask();
  const tasks = tasksOf(view, node);
  const lamp = lampOf(tasks);
  const lines = view.map.edges.filter((e) => e.type !== "together");
  const talksTo = lines.filter((e) => e.from === node.id);
  const usedBy = lines.filter((e) => e.to === node.id);
  const together = view.map.edges.filter(
    (e) => e.type === "together" && (e.from === node.id || e.to === node.id),
  );
  const isProject = node.kind === "project" || node.kind === "library";
  const dependents = [...new Set(usedBy.map((e) => labelOf(view, e.from)))];

  const row = (e: MapEdge, out: boolean) => (
    <button key={e.id} type="button" onClick={() => onSelect({ kind: "edge", id: e.id })} className={ROW}>
      <span style={{ color: EDGE_PRESETS[e.type].color }} aria-hidden="true">
        {out ? <ArrowRight className="size-3.5" /> : <ArrowLeft className="size-3.5" />}
      </span>
      <span className="truncate font-mono text-sm text-fg">{labelOf(view, out ? e.to : e.from)}</span>
      <span className="truncate text-fg-muted">{e.label}</span>
      {e.state === "new" && (
        <Badge tone="amber" className="ml-auto">
          new
        </Badge>
      )}
    </button>
  );

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-md font-semibold text-fg">
          <span className="truncate">{node.label}</span>
          <Badge mono>{KIND_LABEL[node.kind].toLowerCase()}</Badge>
        </h2>
        <p className="text-sm text-fg-muted">
          {[node.sub, node.deploy === undefined ? undefined : `runs on ${node.deploy}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {lamp !== undefined && (
          <p className="flex items-center gap-1.5 text-sm text-fg-muted">
            <Lamp state={lamp.state} size={7} />
            {lamp.word}
          </p>
        )}
      </div>
      <Group title="Talks to">
        {talksTo.length === 0 ? (
          <p className="text-base text-fg-faint">Nothing</p>
        ) : (
          talksTo.map((e) => row(e, true))
        )}
      </Group>
      <Group title="Used by">
        {usedBy.length === 0 ? (
          <p className="text-base text-fg-faint">Nothing</p>
        ) : (
          usedBy.map((e) => row(e, false))
        )}
      </Group>
      {together.length > 0 && (
        <Group title="Changes together with">
          {together.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect({ kind: "edge", id: e.id })}
              className={ROW}
            >
              <span className="truncate font-mono text-sm text-fg">
                {labelOf(view, e.from === node.id ? e.to : e.from)}
              </span>
              <span className="truncate text-fg-muted">{e.tasks} tasks</span>
            </button>
          ))}
        </Group>
      )}
      {isProject && (
        <Group title="Open tasks">
          {tasks.length === 0 ? (
            <p className="text-base text-fg-faint">None</p>
          ) : (
            tasks.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  void navigate({
                    to: ".",
                    search: (prev: AppSearch): AppSearch => ({ ...prev, task: t.id }),
                  })
                }
                className={ROW}
              >
                <Lamp state={TASK_LAMP[t.status as keyof typeof TASK_LAMP] ?? "idle"} size={7} />
                <span className="shrink-0 font-mono text-sm whitespace-nowrap text-fg-muted">{t.id}</span>
                <span className="truncate">{t.title}</span>
              </button>
            ))
          )}
        </Group>
      )}
      {isProject && (
        <Group title="If you change its API">
          <p className="text-base text-fg-muted">
            {dependents.length === 0
              ? "Nothing else on this map depends on it."
              : `${dependents.join(", ")} ${dependents.length === 1 ? "depends" : "depend"} on it. Agents working here are told this.`}
          </p>
        </Group>
      )}
      {node.project !== undefined && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => newTask.openFor(node.project as string)}>New task here</Button>
          <Button
            onClick={() =>
              void navigate({
                to: "/projects",
                search: (prev: AppSearch): AppSearch => ({ ...prev, project: node.project as string }),
              })
            }
          >
            Open project
          </Button>
        </div>
      )}
    </>
  );
}

const FOUND_BY = {
  config: "Reading the project's config files.",
  history: "Tasks in majhi that changed both projects.",
  agent: "The last map update read the code and found this. Check it once.",
} as const;

function EdgePanel({
  view,
  edge,
  onSelect,
}: {
  view: MapView;
  edge: MapEdge;
  onSelect: (selection: Selection) => void;
}) {
  const confirm = useConfirmEdge(view.org);
  const remove = useRemoveEdge(view.org);
  const pathOf = (project: string) => view.projects.find((p) => p.id === project)?.path;
  const error = confirm.error ?? remove.error;
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-md font-semibold text-fg">
          <span aria-hidden="true" style={{ color: EDGE_PRESETS[edge.type].color }}>
            ●
          </span>
          <span className="truncate">
            {labelOf(view, edge.from)} → {labelOf(view, edge.to)}
          </span>
        </h2>
        <p className="text-sm text-fg-muted">
          {MAP_EDGE_LABEL[edge.type]}: {edge.label}
        </p>
      </div>
      <Group title="Proof">
        {edge.evidence.length === 0 ? (
          <p className="text-base text-fg-muted">
            {edge.type === "together"
              ? `${edge.tasks ?? 0} tasks changed both projects.`
              : "No file shows this."}
          </p>
        ) : (
          edge.evidence.map((p) => {
            const root = pathOf(p.project);
            return (
              <div key={`${p.project}:${p.file}:${p.line}`} className="flex flex-col gap-1.5 pb-2">
                <div className="flex items-center gap-2">
                  <span
                    className="min-w-0 truncate font-mono text-sm text-blue"
                    title={`${p.project}/${p.file}:${p.line}`}
                  >
                    {p.project}/{p.file}:{p.line}
                  </span>
                  {root !== undefined && (
                    <OpenInEditor
                      path={`${root}/${p.file}`}
                      line={p.line}
                      name={p.file}
                      size="icon-sm"
                      variant="ghost"
                    />
                  )}
                </div>
                <pre className="overflow-x-auto rounded-md border border-line bg-sunken px-2.5 py-2 font-mono text-sm break-all whitespace-pre-wrap text-fg-soft">
                  {p.excerpt}
                </pre>
              </div>
            );
          })
        )}
      </Group>
      <Group title="Found by">
        <p className="text-base text-fg-muted">{FOUND_BY[edge.source]}</p>
      </Group>
      <div className="flex flex-wrap gap-2">
        {edge.state === "new" && (
          <Button variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate(edge.id)}>
            Looks right
          </Button>
        )}
        <Button
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(edge.id, { onSuccess: () => onSelect({ kind: "node", id: edge.from }) })
          }
        >
          Remove line
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-red">
          {error.message}
        </p>
      )}
    </>
  );
}

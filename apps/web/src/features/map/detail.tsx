import {
  type InsideView,
  type JourneyStep,
  type JourneyStepView,
  type JourneyView,
  MAP_ROLE_LABEL,
  MAP_ROLES,
  type MapRole,
  type MapView,
} from "@majhi/shared";
import { useToast } from "@/components/ui/toast";
import { useEditorLabel, useOpenInEditor } from "@/lib/editor-queries";
import {
  useConfirmEdge,
  useRemoveEdge,
  useRemoveJourney,
  useSaveJourney,
  useSetRole,
} from "@/lib/map-queries";
import { RoleBadge, Tag } from "./brand";
import { Ic } from "./icons";
import { InsideDetail } from "./inside-detail";
import { type Graph, LINE_KIND_LABEL, type PEdge, type PNode, TIER_LABEL, TIER_WHY } from "./model";
import type { Compose, UiState } from "./use-map-state";

export interface DetailActs {
  setDir: (d: "out" | "in") => void;
  selectEdge: (id: string) => void;
  openProject: (id: string) => void;
  openInside: (project: string, entry?: string) => void;
  pickEntry: (id: string) => void;
  pickInside: (sel: { t: "fn" | "dn"; id: string } | null) => void;
  pickInsideStep: (i: number | null) => void;
  clearAll: () => void;
  setView: (v: "overview" | "project" | "journeys") => void;
  stepGo: (i: number) => void;
  showOnMap: (id: string) => void;
  pickJourney: (id: string) => void;
  pickNode: (id: string) => void;
  newTask: (project: string) => void;
  edit: (j: JourneyView) => void;
  setCompose: (c: Compose | null) => void;
  /** After a save: show the journey. */
  saved: (id: string | undefined) => void;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The right panel: what is picked, in the mockup's blocks. Never lays anything out. */
export function Detail({
  view,
  graph,
  journeys,
  s,
  acts,
  inside,
  entryId,
}: {
  view: MapView;
  graph: Graph;
  journeys: readonly JourneyView[];
  s: UiState;
  acts: DetailActs;
  /** What is inside the project on show (the Inside tab). Undefined while it loads. */
  inside: InsideView | undefined;
  entryId: string | null;
}) {
  if (s.compose !== null && s.view === "overview") {
    return <ComposePanel view={view} graph={graph} compose={s.compose} acts={acts} />;
  }
  if (s.view === "journeys")
    return <JourneyPanel view={view} graph={graph} journeys={journeys} s={s} acts={acts} />;
  if (s.sel?.t === "edge") {
    const e = graph.edgeById.get(s.sel.id);
    if (e !== undefined)
      return <EdgePanel view={view} graph={graph} journeys={journeys} edge={e} acts={acts} />;
  }
  const id = s.view === "project" ? s.focus : s.sel?.t === "node" ? s.sel.id : null;
  const node = id === null ? undefined : graph.byId.get(id);
  if (node === undefined) return <EmptyPanel graph={graph} s={s} acts={acts} />;
  if (s.view === "project" && s.tab === "inside") {
    return (
      <InsideDetail
        view={view}
        node={node}
        inside={inside}
        entryId={entryId}
        journeys={journeys}
        s={s}
        acts={{ ...acts, newTask: acts.newTask }}
      />
    );
  }
  return <NodePanel view={view} graph={graph} node={node} s={s} acts={acts} />;
}

function EmptyPanel({ graph, s, acts }: { graph: Graph; s: UiState; acts: DetailActs }) {
  if (s.view === "overview" && s.trace !== null) {
    return (
      <>
        <div className="dhead">
          <div className="t">
            <span className="nm">{s.trace.title}</span>
            <span className="bdg">Example</span>
          </div>
          <div className="s">{s.trace.edges.length} steps on the map</div>
        </div>
        <div className="scroll">
          <div className="dbody">
            <div className="blk">
              <div className="glabel">Steps</div>
              {s.trace.edges.map((eid, k) => {
                const e = graph.edgeById.get(eid);
                if (e === undefined) return null;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a line can be two steps
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: a line can be two steps
                    key={`${eid}:${k}`}
                    type="button"
                    className="link"
                    onClick={() => acts.selectEdge(eid)}
                  >
                    <span className="num">{k + 1}</span>
                    <span className="nm">
                      {graph.byId.get(e.from)?.label ?? e.from} → {graph.byId.get(e.to)?.label ?? e.to}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="dfoot">
          <button type="button" className="btn sec" onClick={acts.clearAll}>
            Clear trace
          </button>
        </div>
      </>
    );
  }
  const check = graph.edges.filter((e) => e.tier === "check");
  return (
    <>
      <div className="dhead">
        <div className="t">
          <span className="nm">Nothing picked</span>
        </div>
        <div className="s">
          {graph.totals.projects} projects · {graph.totals.links} links
        </div>
      </div>
      <div className="scroll">
        <div className="dbody">
          <div className="blk">
            <div className="sub">
              Pick a project to see what it talks to and who uses it. Click one to trace its calls step by
              step.
            </div>
          </div>
          {check.length > 0 && (
            <div className="blk">
              <div className="glabel">Needs a check</div>
              {check.map((e) => (
                <button key={e.id} type="button" className="link" onClick={() => acts.selectEdge(e.id)}>
                  <span className="nm">
                    {graph.byId.get(e.from)?.label ?? e.from} → {graph.byId.get(e.to)?.label ?? e.to}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function LinkRow({
  graph,
  e,
  dir,
  on,
  onClick,
}: {
  graph: Graph;
  e: PEdge;
  dir: "out" | "in";
  on: boolean;
  onClick: () => void;
}) {
  const other = dir === "out" ? e.to : e.from;
  return (
    <button type="button" className={`link ${on ? "on" : ""}`} onClick={onClick}>
      <span className="arr">
        <Ic n="arrow" />
      </span>
      <span className="nm">{graph.byId.get(other)?.label ?? other}</span>
      <span className="lb">{e.label}</span>
    </button>
  );
}

function NodePanel({
  view,
  graph,
  node,
  s,
  acts,
}: {
  view: MapView;
  graph: Graph;
  node: PNode;
  s: UiState;
  acts: DetailActs;
}) {
  const setRole = useSetRole(view.org);
  const id = node.id;
  const outs = graph.outs(id);
  const ins = graph.ins(id);
  const path = node.path;
  const stateTxt =
    node.lamp === "idle" ? (
      <span className="st">
        <i className="lamp idle" />
        idle
      </span>
    ) : (
      <span className={`st ${node.lamp}`}>
        <i className={`lamp ${node.lamp}`} />
        {node.lampWord === "to check" ? "1 link to check" : node.lampWord}
      </span>
    );
  const tracing = s.view === "overview" && s.trace !== null && s.trace.node === id;
  const rawRole = view.map.roles.find((r) => r.project === id)?.role;
  return (
    <>
      <div className="dhead">
        <div className="t">
          <span className="nm">{node.label}</span>
          <RoleBadge label={node.roleLabel} cls={node.roleClass} />
        </div>
        {path !== undefined && <div className="s">{path}</div>}
      </div>
      <div className="scroll fade">
        <div className="dbody">
          <div className="blk">
            <div>{stateTxt}</div>
            {node.desc !== "" && <div className="sub">{node.desc}</div>}
            {!node.connected && <div className="sub">No links found yet.</div>}
          </div>
          {tracing && s.trace !== null && (
            <div className="blk">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div className="glabel">Trace</div>
                <fieldset className="seg2" aria-label="Trace direction">
                  <button type="button" aria-pressed={s.dir === "out"} onClick={() => acts.setDir("out")}>
                    Calls out
                  </button>
                  <button type="button" aria-pressed={s.dir === "in"} onClick={() => acts.setDir("in")}>
                    Calls in
                  </button>
                </fieldset>
              </div>
              {s.trace.edges.length === 0 ? (
                <div className="sub">No links to trace.</div>
              ) : (
                s.trace.edges.map((eid, k) => {
                  const e = graph.edgeById.get(eid);
                  if (e === undefined) return null;
                  const name = (n: string) => graph.byId.get(n)?.label ?? n;
                  return (
                    <button
                      key={eid}
                      type="button"
                      className={`link ${s.sel?.t === "edge" && s.sel.id === eid ? "on" : ""}`}
                      onClick={() => acts.selectEdge(eid)}
                    >
                      <span className="num">{k + 1}</span>
                      <span className="nm">
                        {e.from === id ? "" : `${name(e.from)} → `}
                        {e.to === id && s.dir === "in" ? "" : name(e.to)}
                      </span>
                      {e.from === id && <span className="lb">{e.label}</span>}
                    </button>
                  );
                })
              )}
            </div>
          )}
          <div className="blk">
            <div className="glabel">Talks to</div>
            {outs.length > 0 ? (
              outs.map((e) => (
                <LinkRow
                  key={e.id}
                  graph={graph}
                  e={e}
                  dir="out"
                  on={s.sel?.t === "edge" && s.sel.id === e.id}
                  onClick={() => acts.selectEdge(e.id)}
                />
              ))
            ) : (
              <div className="sub">Nothing found.</div>
            )}
          </div>
          <div className="blk">
            <div className="glabel">Used by</div>
            {ins.length > 0 ? (
              ins.map((e) => (
                <LinkRow
                  key={e.id}
                  graph={graph}
                  e={e}
                  dir="in"
                  on={s.sel?.t === "edge" && s.sel.id === e.id}
                  onClick={() => acts.selectEdge(e.id)}
                />
              ))
            ) : (
              <div className="sub">Nothing found.</div>
            )}
          </div>
          <div className="blk">
            <div className="glabel">Built with</div>
            <div className="chips">
              {node.stack.length > 0 ? (
                node.stack.map((c) => <Tag key={c} name={c} />)
              ) : (
                <span className="sub">Nothing detected</span>
              )}
            </div>
            {node.stores.length > 0 && (
              <>
                <div className="sub">Stores data in</div>
                <div className="chips">
                  {node.stores.map((c) => (
                    <Tag key={c} name={c} />
                  ))}
                </div>
              </>
            )}
            {node.outside.length > 0 && (
              <>
                <div className="sub">Outside services</div>
                <div className="chips">
                  {node.outside.map((c) => (
                    <Tag key={c} name={c} out />
                  ))}
                </div>
              </>
            )}
          </div>
          {node.tasks.length > 0 && (
            <div className="blk">
              <div className="glabel">Open tasks</div>
              {node.tasks.map((t) => (
                <div key={t.id} className="link" style={{ cursor: "default" }}>
                  <span className="nm">
                    <span className="mono" style={{ color: "var(--fg-faint)" }}>
                      {t.id}
                    </span>{" "}
                    {t.title}
                  </span>
                </div>
              ))}
            </div>
          )}
          {node.project !== undefined && (
            <div className="blk">
              <div className="glabel">Role</div>
              <select
                className="field"
                aria-label="Role"
                value={rawRole ?? ""}
                disabled={setRole.isPending}
                onChange={(e) =>
                  setRole.mutate({
                    project: id,
                    ...(e.target.value === "" ? {} : { role: e.target.value as MapRole }),
                  })
                }
              >
                <option value="">{`Auto: ${node.roleLabel}`}</option>
                {MAP_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {MAP_ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              {setRole.error !== null && <div className="sub">{setRole.error.message}</div>}
            </div>
          )}
        </div>
      </div>
      <div className="dfoot">
        {s.view === "overview" ? (
          <button type="button" className="btn pri" onClick={() => acts.openProject(id)}>
            <Ic n="map" />
            Open project
          </button>
        ) : (
          <button
            type="button"
            className="btn pri"
            disabled={node.project === undefined}
            onClick={() => node.project !== undefined && acts.newTask(node.project)}
          >
            New task here
          </button>
        )}
        {s.view === "overview" ? (
          <button
            type="button"
            className="btn sec"
            disabled={node.project === undefined}
            onClick={() => node.project !== undefined && acts.newTask(node.project)}
          >
            New task here
          </button>
        ) : (
          <button type="button" className="btn sec" onClick={() => acts.setView("overview")}>
            Back to map
          </button>
        )}
      </div>
    </>
  );
}

function EdgePanel({
  view,
  graph,
  journeys,
  edge,
  acts,
  kicker,
  inJourney,
}: {
  view: MapView;
  graph: Graph;
  journeys: readonly JourneyView[];
  edge: PEdge;
  acts: DetailActs;
  /** For a journey's step: its place and name. */
  kicker?: { n: number; of: number; label: string } | undefined;
  inJourney?: { id: string } | undefined;
}) {
  const confirm = useConfirmEdge(view.org);
  const remove = useRemoveEdge(view.org);
  const open = useOpenInEditor();
  const toast = useToast();
  const editor = useEditorLabel();
  const tier = TIER_LABEL[edge.tier];
  const name = (n: string) => graph.byId.get(n)?.label ?? n;
  const used = journeys.filter((j) => j.steps.some((st) => st.edge === edge.id));
  const first = edge.proof[0];
  const root = first === undefined ? undefined : view.projects.find((p) => p.id === first.project)?.path;
  const error = confirm.error ?? remove.error;
  return (
    <>
      <div className="dhead">
        {kicker !== undefined && (
          <div className="sub" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="num">{kicker.n}</span>
            Step {kicker.n} of {kicker.of} · {kicker.label}
          </div>
        )}
        <div className="t" style={{ flexWrap: "wrap", gap: "4px 6px" }}>
          <span className="nm" style={{ flex: "0 1 auto" }}>
            {name(edge.from)}
          </span>
          <span style={{ color: "var(--fg-faint)", display: "grid" }}>
            <Ic n="arrow" />
          </span>
          <span className="nm" style={{ flex: "0 1 auto" }}>
            {name(edge.to)}
          </span>
        </div>
        <div className="s" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="bdg">{LINE_KIND_LABEL[edge.kind]}</span>
          {edge.label}
        </div>
        {inJourney !== undefined && (
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button type="button" className="btn sec sm" onClick={() => acts.pickJourney(inJourney.id)}>
              <Ic n="back" />
              All steps
            </button>
            <button type="button" className="btn sec sm" onClick={() => acts.showOnMap(inJourney.id)}>
              <Ic n="map" />
              Show on map
            </button>
          </div>
        )}
      </div>
      <div className="scroll fade">
        <div className="dbody">
          <div className="blk">
            <div className="tier">
              <span className={`bdg ${tier.tone}`}>{tier.text}</span>
              <span>{TIER_WHY[edge.tier]}</span>
            </div>
          </div>
          <div className="blk">
            <div className="glabel">Proof</div>
            {edge.proof.length === 0 ? (
              <div className="sub">
                {edge.tier === "answer" ? "You said so. No file shows it yet." : "No file shows this."}
              </div>
            ) : (
              edge.proof.map((p) => (
                <div key={`${p.project}:${p.file}:${p.line}`} className="proof">
                  <div className="f">
                    <Ic n="file" />
                    <span>
                      {p.file}:{p.line}
                    </span>
                  </div>
                  <div className="well">{p.excerpt}</div>
                </div>
              ))
            )}
          </div>
          {used.length > 0 && (
            <div className="blk">
              <div className="glabel">Used in journeys</div>
              {used.map((j) => (
                <button key={j.id} type="button" className="link" onClick={() => acts.pickJourney(j.id)}>
                  <span className="nm">{j.name}</span>
                  <span className="lb">step {j.steps.findIndex((st) => st.edge === edge.id) + 1}</span>
                </button>
              ))}
            </div>
          )}
          {error !== null && <div className="sub">{error.message}</div>}
        </div>
      </div>
      <div className="dfoot">
        {edge.tier === "check" ? (
          <>
            <button
              type="button"
              className="btn pri"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate(edge.id)}
            >
              Confirm link
            </button>
            <button
              type="button"
              className="btn sec"
              disabled={remove.isPending}
              onClick={() => remove.mutate(edge.id, { onSuccess: acts.clearAll })}
            >
              Not a link
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn sec"
              disabled={first === undefined || root === undefined || open.isPending}
              title={`Open in ${editor}`}
              onClick={() =>
                first !== undefined &&
                root !== undefined &&
                open.mutate(
                  { path: `${root}/${first.file}`, line: first.line },
                  {
                    onSuccess: (done) => toast(`Opened in ${editor}`, { detail: done.path }),
                    onError: (e) =>
                      toast(`Could not open in ${editor}`, { detail: e.message, tone: "error" }),
                  },
                )
              }
            >
              <Ic n="file" />
              Open file
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate(edge.id, { onSuccess: acts.clearAll })}
            >
              Not a link
            </button>
          </>
        )}
      </div>
    </>
  );
}

function JourneyPanel({
  view,
  graph,
  journeys,
  s,
  acts,
}: {
  view: MapView;
  graph: Graph;
  journeys: readonly JourneyView[];
  s: UiState;
  acts: DetailActs;
}) {
  const save = useSaveJourney(view.org);
  const remove = useRemoveJourney(view.org);
  const open = useOpenInEditor();
  const toast = useToast();
  const editor = useEditorLabel();
  const j = journeys.find((x) => x.id === s.journey);
  if (j === undefined) {
    return (
      <>
        <div className="dhead">
          <div className="t">
            <span className="nm">No journey</span>
          </div>
        </div>
        <div className="dbody">
          <div className="blk">
            <div className="sub">
              A journey is one thing that happens, step by step, over the links on the map. Name one from the
              rail.
            </div>
          </div>
        </div>
      </>
    );
  }
  const name = (n: string) => graph.byId.get(n)?.label ?? n;
  const example = j.status === "example";
  const keep = () =>
    save.mutate(
      {
        name: j.name,
        steps: j.steps.map(stripCheck),
        trigger: j.trigger,
        ...(j.inner === undefined ? {} : { inner: j.inner }),
      },
      {
        onSuccess: (v) =>
          acts.saved(
            v.journeys.find(
              (x) =>
                x.status === "kept" &&
                x.name === j.name &&
                (j.inner === undefined || x.inner?.entry === j.inner.entry),
            )?.id,
          ),
      },
    );
  const step = s.step === null ? undefined : j.steps[s.step];
  if (step !== undefined && s.step !== null) {
    const e = step.edge === undefined ? undefined : graph.edgeById.get(step.edge);
    if (e !== undefined) {
      return (
        <EdgePanel
          view={view}
          graph={graph}
          journeys={journeys}
          edge={e}
          acts={acts}
          kicker={{ n: s.step + 1, of: j.steps.length, label: step.label }}
          inJourney={{ id: j.id }}
        />
      );
    }
    const proof = step.proof;
    const root =
      j.inner === undefined ? undefined : view.projects.find((p) => p.id === j.inner?.project)?.path;
    return (
      <>
        <div className="dhead">
          <div className="sub" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="num">{s.step + 1}</span>
            Step {s.step + 1} of {j.steps.length} · {step.label}
          </div>
          <div className="t" style={{ flexWrap: "wrap", gap: "4px 6px" }}>
            <span className="nm" style={{ flex: "0 1 auto" }}>
              {name(step.from)}
            </span>
            <span style={{ color: "var(--fg-faint)", display: "grid" }}>
              <Ic n="arrow" />
            </span>
            <span className="nm" style={{ flex: "0 1 auto" }}>
              {name(step.to)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button type="button" className="btn sec sm" onClick={() => acts.pickJourney(j.id)}>
              <Ic n="back" />
              All steps
            </button>
            {j.inner !== undefined && (
              <button
                type="button"
                className="btn sec sm"
                onClick={() => acts.openInside(j.inner?.project ?? "", j.inner?.entry)}
              >
                <Ic n="map" />
                Open inside
              </button>
            )}
          </div>
        </div>
        <div className="scroll fade">
          <div className="dbody">
            <div className="blk">
              <div className="tier">
                {proof === undefined ? (
                  <>
                    <span className="bdg caution">Needs a check</span>
                    <span>
                      The link this step followed is no longer on the map. The step stays until you change it.
                    </span>
                  </>
                ) : (
                  <>
                    <span className="bdg green">Found in code</span>
                    <span>majhi read this step in the code.</span>
                  </>
                )}
              </div>
            </div>
            {proof !== undefined && (
              <div className="blk">
                <div className="glabel">Proof</div>
                <div className="proof">
                  <div className="f">
                    <Ic n="file" />
                    <span>
                      {proof.file}:{proof.line}
                    </span>
                  </div>
                  <div className="well">{proof.text}</div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="dfoot">
          {proof !== undefined ? (
            <button
              type="button"
              className="btn sec"
              disabled={root === undefined || open.isPending}
              title={`Open in ${editor}`}
              onClick={() =>
                root !== undefined &&
                open.mutate(
                  { path: `${root}/${proof.file}`, line: proof.line },
                  {
                    onSuccess: (done) => toast(`Opened in ${editor}`, { detail: done.path }),
                    onError: (e2) =>
                      toast(`Could not open in ${editor}`, { detail: e2.message, tone: "error" }),
                  },
                )
              }
            >
              <Ic n="file" />
              Open file
            </button>
          ) : (
            <button type="button" className="btn sec" onClick={() => acts.edit(j)}>
              Edit steps
            </button>
          )}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="dhead">
        <div className="t">
          <span className="nm">{j.name}</span>
          <span className={`bdg ${example ? "" : "green"}`}>{example ? "Suggested" : "Yours"}</span>
        </div>
        <div className="s">{j.steps.length} steps</div>
      </div>
      <div className="scroll">
        <div className="dbody">
          <div className="blk">
            <div className="sub">
              {example
                ? j.inner === undefined
                  ? "A guess built from the links majhi found. Pick a step to see its proof, or say what really happens."
                  : "Built from the code of this project. Pick a step to see the line it comes from."
                : "Pick a step to see its proof."}
            </div>
          </div>
          <div className="blk">
            <div className="glabel">Steps</div>
            {j.steps.map((st, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: steps have no id of their own
                key={`${st.from}>${st.to}:${i}`}
                type="button"
                className="link"
                onClick={() => acts.stepGo(i)}
              >
                <span className="num">{i + 1}</span>
                <span className="nm">{st.label}</span>
                <span className="lb">{st.from === st.to ? "" : cut(name(st.from), 12)}</span>
              </button>
            ))}
          </div>
          {(save.error ?? remove.error) !== null && (
            <div className="sub">{(save.error ?? remove.error)?.message}</div>
          )}
        </div>
      </div>
      <div className="dfoot">
        {j.inner === undefined ? (
          <button type="button" className="btn pri" onClick={() => acts.showOnMap(j.id)}>
            <Ic n="map" />
            Show on map
          </button>
        ) : (
          <button
            type="button"
            className="btn pri"
            onClick={() => acts.openInside(j.inner?.project ?? "", j.inner?.entry)}
          >
            <Ic n="map" />
            Open inside
          </button>
        )}
        {j.inner === undefined && (
          <button type="button" className="btn sec" onClick={() => acts.edit(j)}>
            Edit steps
          </button>
        )}
        {example ? (
          <button type="button" className="btn ghost" disabled={save.isPending} onClick={keep}>
            Keep journey
          </button>
        ) : (
          <button
            type="button"
            className="btn ghost"
            disabled={remove.isPending}
            onClick={() => remove.mutate(j.id, { onSuccess: () => acts.saved(undefined) })}
          >
            Remove journey
          </button>
        )}
      </div>
    </>
  );
}

function stripCheck(st: JourneyStepView): JourneyStep {
  const { check: _check, ...step } = st;
  return step;
}

/** Naming a journey: the steps picked so far, each with a label to edit, and the name. */
function ComposePanel({
  view,
  graph,
  compose,
  acts,
}: {
  view: MapView;
  graph: Graph;
  compose: Compose;
  acts: DetailActs;
}) {
  const save = useSaveJourney(view.org);
  const name = (n: string) => graph.byId.get(n)?.label ?? n;
  const ready = compose.name.trim() !== "" && compose.steps.length > 0;
  const set = (steps: JourneyStep[]) => acts.setCompose({ ...compose, steps });
  return (
    <>
      <div className="dhead">
        <div className="t">
          <span className="nm">{compose.id === undefined ? "Name a journey" : "Edit journey"}</span>
        </div>
        <div className="s">{compose.steps.length} steps</div>
      </div>
      <div className="scroll">
        <div className="dbody">
          <div className="blk">
            <label className="glabel" htmlFor="journey-name">
              Name
            </label>
            <input
              id="journey-name"
              className="field"
              value={compose.name}
              maxLength={60}
              placeholder="Order a part"
              onChange={(e) => acts.setCompose({ ...compose, name: e.target.value })}
            />
            <div className="sub">Click the lines on the map in the order they happen.</div>
          </div>
          <div className="blk">
            <div className="glabel">Steps</div>
            {compose.steps.length === 0 && <div className="sub">No steps yet.</div>}
            {compose.steps.map((st, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps have no id of their own
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: steps have no id of their own
                key={`${st.from}>${st.to}:${i}`}
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="num">{i + 1}</span>
                  <span
                    className="sub"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {name(st.from)} → {name(st.to)}
                  </span>
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() => set(compose.steps.filter((_, k) => k !== i))}
                  >
                    <Ic n="x" />
                  </button>
                </div>
                <input
                  className="field"
                  aria-label={`Step ${i + 1} label`}
                  value={st.label}
                  maxLength={60}
                  onChange={(e) =>
                    set(compose.steps.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))
                  }
                />
              </div>
            ))}
          </div>
          {save.error !== null && <div className="sub">{save.error.message}</div>}
        </div>
      </div>
      <div className="dfoot">
        <button
          type="button"
          className="btn pri"
          disabled={!ready || save.isPending}
          onClick={() =>
            save.mutate(
              {
                ...(compose.id === undefined ? {} : { id: compose.id }),
                name: compose.name.trim(),
                steps: compose.steps.map((x) => ({
                  ...x,
                  label: x.label.trim() === "" ? "Step" : x.label.trim(),
                })),
              },
              {
                onSuccess: (v) => {
                  const mine =
                    compose.id ??
                    v.journeys.findLast((x) => x.status === "kept" && x.name === compose.name.trim())?.id;
                  acts.saved(mine);
                },
              },
            )
          }
        >
          Save journey
        </button>
        <button type="button" className="btn sec" onClick={() => acts.setCompose(null)}>
          Cancel
        </button>
      </div>
    </>
  );
}

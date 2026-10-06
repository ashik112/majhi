import {
  flowOf,
  type InsideEntry,
  type InsideSpec,
  type InsideStep,
  type InsideView,
  type JourneyView,
  type MapView,
  STEPS_SHOWN,
  stepsOf,
} from "@majhi/shared";
import { FileCode, Layers } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useEditorLabel, useOpenInEditor } from "@/lib/editor-queries";
import { useInsideMember, useReadInside } from "@/lib/map-queries";
import { Li, RoleBadge, Tag, TriggerIcon } from "./brand";
import { DataIcon } from "./inside-world";
import type { PNode } from "./model";
import type { UiState } from "./use-map-state";

export interface InsideActs {
  pickEntry: (id: string) => void;
  pickInside: (sel: { t: "fn" | "dn"; id: string } | null) => void;
  pickInsideStep: (i: number | null) => void;
  pickJourney: (id: string) => void;
  openProject: (id: string) => void;
  newTask: (project: string) => void;
}

/** Opens a file of the project in the owner's editor. */
function OpenFile({
  view,
  project,
  file,
  line,
}: {
  view: MapView;
  project: string;
  file: string;
  line: number;
}) {
  const open = useOpenInEditor();
  const toast = useToast();
  const editor = useEditorLabel();
  const root = view.projects.find((p) => p.id === project)?.path;
  return (
    <button
      type="button"
      className="btn sec"
      disabled={root === undefined || open.isPending}
      title={`Open in ${editor}`}
      onClick={() =>
        root !== undefined &&
        open.mutate(
          { path: `${root}/${file}`, line },
          {
            onSuccess: (done) => toast(`Opened in ${editor}`, { detail: done.path }),
            onError: (e) => toast(`Could not open in ${editor}`, { detail: e.message, tone: "error" }),
          },
        )
      }
    >
      <FileCode aria-hidden="true" className="i" strokeWidth={1.6} />
      Open file
    </button>
  );
}

function Head({
  title,
  sub,
  badge,
  mono,
}: {
  title: ReactNode;
  sub: string;
  badge?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="dhead">
      <div className="t">
        <span className={`nm ${mono ? "mono" : ""}`} style={mono ? { fontSize: 13 } : undefined}>
          {title}
        </span>
        {badge}
      </div>
      <div className="s">{sub}</div>
    </div>
  );
}

function Row({
  icon,
  name,
  label,
  mono,
  onClick,
}: {
  icon: ReactNode;
  name: string;
  label: string;
  mono?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="link" onClick={onClick}>
      {icon}
      <span className={`nm ${mono ? "mono" : ""}`} style={mono ? { fontSize: 12 } : undefined}>
        {name}
      </span>
      <span className="lb">{label}</span>
    </button>
  );
}

const fnIcon = (
  <FileCode aria-hidden="true" className="i ri" strokeWidth={1.6} style={{ width: 13, height: 13 }} />
);

/**
 * The right panel of the Inside tab. It follows what is picked: a function, a piece of data, an entry point
 * (its story, in plain words with the line of code behind every step), or the project as a whole. A project
 * majhi has not read yet offers "Read inside".
 */
export function InsideDetail({
  view,
  node,
  inside,
  entryId,
  journeys,
  s,
  acts,
}: {
  view: MapView;
  node: PNode;
  inside: InsideView | undefined;
  entryId: string | null;
  journeys: readonly JourneyView[];
  s: UiState;
  acts: InsideActs;
}) {
  const read = useReadInside(view.org);
  const spec = inside?.spec;
  if (spec === undefined) {
    const loading = inside === undefined;
    return (
      <>
        <Head
          title={node.label}
          sub={node.path ?? ""}
          badge={<RoleBadge label={node.roleLabel} cls={node.roleClass} />}
        />
        <div className="scroll">
          <div className="dbody">
            <div className="blk">
              <div className="sub">
                {loading
                  ? "Looking inside."
                  : `majhi has not read inside ${node.label} yet. Reading shows its entry points, steps and the data it uses.`}
              </div>
              {read.error !== null && <div className="sub">{read.error.message}</div>}
            </div>
          </div>
        </div>
        <div className="dfoot">
          <button
            type="button"
            className="btn pri"
            disabled={loading || read.isPending || node.project === undefined}
            onClick={() => node.project !== undefined && read.mutate(node.project)}
          >
            <FileCode aria-hidden="true" className="i" strokeWidth={1.6} />
            {read.isPending ? "Reading" : "Read inside"}
          </button>
        </div>
      </>
    );
  }
  return (
    <ReadInside view={view} node={node} spec={spec} entryId={entryId} journeys={journeys} s={s} acts={acts} />
  );
}

function ReadInside({
  view,
  node,
  spec,
  entryId,
  journeys,
  s,
  acts,
}: {
  view: MapView;
  node: PNode;
  spec: InsideSpec;
  entryId: string | null;
  journeys: readonly JourneyView[];
  s: UiState;
  acts: InsideActs;
}) {
  const project = node.project ?? node.id;
  const dataById = new Map(spec.data.map((d) => [d.id, d]));
  const isel = s.isel;

  if (isel?.t === "fn") {
    const f = spec.fns.find((x) => x.id === isel.id);
    if (f !== undefined) {
      const from = [
        ...spec.entries
          .filter((e) => e.fn === f.id)
          .map((e) => (
            <Row
              key={`e${e.id}`}
              icon={<TriggerIcon kind={e.kind} />}
              name={e.label}
              label={e.kind}
              mono
              onClick={() => acts.pickEntry(e.id)}
            />
          )),
        ...spec.calls
          .filter((c) => c.to === f.id)
          .map((c) => (
            <Row
              key={`c${c.from}`}
              icon={fnIcon}
              name={c.from}
              label="function"
              mono
              onClick={() => acts.pickInside({ t: "fn", id: c.from })}
            />
          )),
      ];
      const to = [
        ...spec.calls
          .filter((c) => c.from === f.id)
          .map((c) => (
            <Row
              key={`c${c.to}`}
              icon={fnIcon}
              name={c.to}
              label="function"
              mono
              onClick={() => acts.pickInside({ t: "fn", id: c.to })}
            />
          )),
        ...spec.uses
          .filter((u) => u.fn === f.id)
          .flatMap((u) => {
            const d = dataById.get(u.data);
            return d === undefined
              ? []
              : [
                  <Row
                    key={`d${u.data}`}
                    icon={<DataIcon kind={d.kind} name={d.name} />}
                    name={d.name}
                    label={d.kind === "db" ? "table" : d.kind === "out" ? "outside" : "project"}
                    onClick={() => acts.pickInside({ t: "dn", id: d.id })}
                  />,
                ];
          }),
      ];
      return (
        <>
          <Head
            title={f.id}
            sub={`${f.file}:${f.line}`}
            mono
            badge={
              <span className="bdg" style={{ marginLeft: "auto" }}>
                <Li n="layers" />
                {f.service}
              </span>
            }
          />
          <div className="scroll fade">
            <div className="dbody">
              <div className="blk">
                <div className="glabel">What it does</div>
                <div className="sub" style={{ fontSize: 13, color: "var(--fg-soft)" }}>
                  {f.doc === "" ? "The code does not say." : f.doc.endsWith(".") ? f.doc : `${f.doc}.`}
                </div>
              </div>
              <div className="blk">
                <div className="glabel">Called from</div>
                {from.length > 0 ? from : <div className="sub">Nothing found.</div>}
              </div>
              <div className="blk">
                <div className="glabel">Calls</div>
                {to.length > 0 ? to : <div className="sub">Nothing found.</div>}
              </div>
            </div>
          </div>
          <div className="dfoot">
            <OpenFile view={view} project={project} file={f.file} line={f.line} />
          </div>
        </>
      );
    }
  }
  if (isel?.t === "dn") {
    const d = dataById.get(isel.id);
    if (d !== undefined) {
      const used = spec.uses.filter((u) => u.data === d.id);
      return (
        <>
          <Head
            title={d.name}
            sub={d.sub}
            badge={
              <span className="bdg" style={{ marginLeft: "auto" }}>
                <DataIcon kind={d.kind} name={d.name} />
                {d.kind === "db" ? "Database" : d.kind === "out" ? "Outside" : "Project"}
              </span>
            }
          />
          <div className="scroll fade">
            <div className="dbody">
              <div className="blk">
                <div className="glabel">Used by</div>
                {used.map((u) => (
                  <Row
                    key={u.fn}
                    icon={fnIcon}
                    name={u.fn}
                    label="function"
                    mono
                    onClick={() => acts.pickInside({ t: "fn", id: u.fn })}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="dfoot">
            {used[0] !== undefined && (
              <OpenFile view={view} project={project} file={used[0].file} line={used[0].line} />
            )}
          </div>
        </>
      );
    }
  }
  const entry = entryId === null ? undefined : spec.entries.find((e) => e.id === entryId);
  if (entry !== undefined) {
    const steps = flowOf(spec, entry);
    const jn = journeys.find((j) => j.inner?.project === spec.project && j.inner.entry === entry.id);
    return (
      <>
        <Head
          title={entry.label}
          sub={`${entry.raw !== "" ? `${entry.raw} · ` : ""}${entry.file}:${entry.line}`}
          mono
          badge={
            <span className="bdg" style={{ marginLeft: "auto" }}>
              <TriggerIcon kind={entry.kind} />
              {entry.kind}
            </span>
          }
        />
        <div className="scroll fade">
          <div className="dbody">
            <div className="blk">
              <div className="tier">
                <span className="bdg green">Found in code</span>
                <span>majhi read every step below in the code.</span>
              </div>
            </div>
            <div className="blk">
              <div className="glabel">What happens</div>
              <Steps key={entry.id} steps={steps} cur={s.istep} onPick={(i) => acts.pickInsideStep(i)} />
            </div>
            {entry.members.length > 1 && <Members entry={entry} org={view.org} project={project} />}
            {jn !== undefined && (
              <div className="blk">
                <div className="glabel">Journey</div>
                <button type="button" className="link" onClick={() => acts.pickJourney(jn.id)}>
                  <span className="bdg">
                    <TriggerIcon kind={jn.trigger} />
                    {jn.trigger}
                  </span>
                  <span className="nm">{jn.name}</span>
                  <span className="lb">{jn.steps.length} steps</span>
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="dfoot">
          <OpenFile view={view} project={project} file={entry.file} line={entry.line} />
          {jn !== undefined && (
            <button type="button" className="btn sec" onClick={() => acts.pickJourney(jn.id)}>
              <Li n="route" />
              Show journey
            </button>
          )}
        </div>
      </>
    );
  }
  const outside = spec.data.filter((d) => d.kind === "out").map((d) => d.name);
  const mine = journeys.filter(
    (j) => j.inner?.project === node.id || (j.inner === undefined && j.touches.includes(node.id)),
  );
  return (
    <>
      <Head
        title={node.label}
        sub={node.path ?? ""}
        badge={<RoleBadge label={node.roleLabel} cls={node.roleClass} />}
      />
      <div className="scroll fade">
        <div className="dbody">
          {node.desc !== "" && (
            <div className="blk">
              <div className="sub" style={{ fontSize: 13, color: "var(--fg-soft)" }}>
                {node.desc}
              </div>
            </div>
          )}
          <EntryList spec={spec} acts={acts} />
          <div className="blk">
            <div className="glabel">Services</div>
            {spec.services.map((svc) => {
              const n = spec.fns.filter((f) => f.service === svc).length;
              return (
                <div key={svc} className="link" style={{ cursor: "default" }}>
                  <Layers
                    aria-hidden="true"
                    className="i ri"
                    strokeWidth={1.6}
                    style={{ width: 13, height: 13 }}
                  />
                  <span className="nm">{svc}</span>
                  <span className="lb">
                    {n} {n === 1 ? "step" : "steps"}
                  </span>
                </div>
              );
            })}
          </div>
          {(spec.dbs.length > 0 || spec.declared.length > 0) && (
            <div className="blk">
              <div className="glabel">Databases</div>
              {spec.dbs.map((d) => (
                <div key={d} className="link" style={{ cursor: "default" }}>
                  <DataIcon kind="db" name={d} />
                  <span className="nm">{d}</span>
                </div>
              ))}
              {spec.declared.length > 0 && (
                <div className="sub">
                  Named in the dependencies but not used by any entry point: {spec.declared.join(", ")}.
                </div>
              )}
            </div>
          )}
          {outside.length > 0 && (
            <div className="blk">
              <div className="glabel">Outside services</div>
              <div className="chips">
                {outside.map((x) => (
                  <Tag key={x} name={x} out />
                ))}
              </div>
            </div>
          )}
          <div className="blk">
            <div className="glabel">Journeys</div>
            {mine.length > 0 ? (
              mine.map((j) => (
                <button key={j.id} type="button" className="link" onClick={() => acts.pickJourney(j.id)}>
                  <span className="bdg">
                    <TriggerIcon kind={j.trigger} />
                    {j.trigger}
                  </span>
                  <span className="nm">{j.name}</span>
                </button>
              ))
            ) : (
              <div className="sub">None yet.</div>
            )}
          </div>
        </div>
      </div>
      <div className="dfoot">
        <button
          type="button"
          className="btn pri"
          disabled={node.project === undefined}
          onClick={() => node.project !== undefined && acts.newTask(node.project)}
        >
          New task here
        </button>
      </div>
    </>
  );
}

const KIND_WORDS: Record<InsideEntry["kind"], string> = {
  HTTP: "Requests",
  SOCKET: "Live connections",
  TOOL: "Agent tools",
  SCHEDULE: "Timers",
  QUEUE: "Jobs",
  COMMAND: "Command line",
};
const KIND_ORDER: readonly InsideEntry["kind"][] = ["HTTP", "SOCKET", "TOOL", "SCHEDULE", "QUEUE", "COMMAND"];

/** The story of an entry point: a few steps between parts of the project, the rest behind "Show more". */
function Steps({
  steps,
  cur,
  onPick,
}: {
  steps: readonly InsideStep[];
  cur: number | null;
  onPick: (i: number) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? steps : steps.slice(0, STEPS_SHOWN);
  return (
    <>
      {shown.map((st, i) => (
        <button
          key={st.key}
          type="button"
          className={`stp ${cur === i ? "on" : ""}`}
          data-isel-step={i}
          onClick={() => onPick(i)}
        >
          <span className="num">{i + 1}</span>
          <span>
            <b>{st.part}:</b> {st.text}
            {cur === i && (
              <>
                {st.fns.length === 0 && <span className="f">{st.where}</span>}
                {st.fns.map((f) => (
                  <span key={`${f.file}:${f.line}:${f.id}`} className="f" title={`${f.file}:${f.line}`}>
                    {f.id} · {f.file.split("/").pop()}:{f.line}
                  </span>
                ))}
              </>
            )}
          </span>
        </button>
      ))}
      {steps.length > STEPS_SHOWN && (
        <button type="button" className="link" onClick={() => setAll(!all)}>
          <span className="nm">
            {all ? "Show fewer steps" : `Show ${steps.length - STEPS_SHOWN} more steps`}
          </span>
        </button>
      )}
    </>
  );
}

/** The part of a command name before its first dot, slash or colon: `tasks.create` is `tasks`. */
function prefixOf(label: string): string {
  const cuts = [".", "/", ":"].map((c) => label.indexOf(c)).filter((i) => i > 0);
  return cuts.length === 0 ? "other" : label.slice(0, Math.min(...cuts));
}

/** The commands, routes or tools grouped under one entry point, by name prefix. A command opens its own story. */
function Members({ entry, org, project }: { entry: InsideEntry; org: string; project: string }) {
  const [group, setGroup] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const groups = useMemo(() => {
    const by = new Map<string, InsideEntry["members"]>();
    for (const m of entry.members) by.set(prefixOf(m.label), [...(by.get(prefixOf(m.label)) ?? []), m]);
    return [...by].toSorted((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [entry]);
  const story = useInsideMember(org, project, entry.id, picked);
  return (
    <div className="blk">
      <div className="glabel">
        {entry.raw.includes(":name") ? "Commands" : "Handlers"} · {entry.count}
      </div>
      {groups.map(([name, items]) => (
        <div key={name}>
          <button type="button" className="link" onClick={() => setGroup(group === name ? null : name)}>
            <span className="nm mono" style={{ fontSize: 12 }}>
              {name}
              {items.length > 1 || name !== "other" ? ".*" : ""}
            </span>
            <span className="lb">{items.length}</span>
          </button>
          {group === name &&
            items.map((m) => (
              <div key={`${m.label}:${m.line}`}>
                <button
                  type="button"
                  className={`link ${picked === m.label ? "on" : ""}`}
                  style={{ paddingLeft: 18 }}
                  onClick={() => setPicked(picked === m.label ? null : m.label)}
                >
                  <span className="nm mono" style={{ fontSize: 12 }}>
                    {m.label}
                  </span>
                  <span className="lb">
                    {m.file.split("/").pop()}:{m.line}
                  </span>
                </button>
                {picked === m.label && (
                  <div style={{ paddingLeft: 18 }}>
                    {story.isPending && <div className="sub">Reading the code of {m.label}</div>}
                    {story.data !== undefined && (
                      <>
                        {!story.data.followed && (
                          <div className="sub">
                            majhi cannot follow what {m.label} calls: the code does not tie it to the
                            functions it runs.
                          </div>
                        )}
                        <Steps steps={stepsOf(story.data.steps)} cur={null} onPick={() => undefined} />
                      </>
                    )}
                    {story.isError && <div className="sub">Could not read this command.</div>}
                  </div>
                )}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

/** Entry points by kind with their counts: the drawn ones first, the rest behind "Show more". */
function EntryList({ spec, acts }: { spec: InsideSpec; acts: InsideActs }) {
  const [more, setMore] = useState(false);
  return (
    <div className="blk">
      <div className="glabel">Entry points</div>
      {spec.entries.length === 0 && spec.more.length === 0 && <div className="sub">None found.</div>}
      {KIND_ORDER.map((kind) => {
        const drawn = spec.entries.filter((e) => e.kind === kind);
        const rest = more ? spec.more.filter((e) => e.kind === kind) : [];
        if (drawn.length === 0 && rest.length === 0) return null;
        return (
          <div key={kind}>
            <div className="sub" style={{ margin: "6px 0 2px" }}>
              {KIND_WORDS[kind]} · {spec.totals[kind] ?? drawn.length}
            </div>
            {drawn.map((e) => (
              <Row
                key={e.id}
                icon={<TriggerIcon kind={e.kind} />}
                name={e.label}
                label={e.count > 1 ? `${e.count}` : ""}
                onClick={() => acts.pickEntry(e.id)}
              />
            ))}
            {rest.map((e) => (
              <div key={e.id} className="link" style={{ cursor: "default" }}>
                <TriggerIcon kind={e.kind} />
                <span className="nm">{e.label}</span>
                <span className="lb">{e.count > 1 ? `${e.count}` : ""}</span>
              </div>
            ))}
          </div>
        );
      })}
      {spec.more.length > 0 && (
        <button type="button" className="link" onClick={() => setMore(!more)}>
          <span className="nm">{more ? "Show fewer" : `Show ${spec.more.length} more`}</span>
        </button>
      )}
    </div>
  );
}

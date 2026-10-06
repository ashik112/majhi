import { flowOf, type InsideSpec } from "@majhi/shared";
import { FileCode, Layers } from "lucide-react";
import { Li, Logo, RoleIcon, TriggerIcon } from "./brand";
import { arrowOf, type InsideLayout, type Pt, roundPath, shorten } from "./layout";
import { LOGOS } from "./logos.generated";
import type { UiState } from "./use-map-state";

interface Acts {
  pickEntry: (id: string) => void;
  pickInside: (sel: { t: "fn" | "dn"; id: string } | null) => void;
  pickInsideStep: (i: number | null) => void;
  /** A box that is another project of the workspace: open it. */
  openProject: (id: string) => void;
}

const base = (file: string) => file.split("/").pop() ?? file;

/**
 * The Inside canvas of one project: entry points on the left, functions in frames by the service that runs
 * them, data and outside services on the right. The picked entry lights its story (numbered, the same
 * numbers as the "What happens" list) and only that story's data lines are drawn.
 */
export function InsideWorld({
  spec,
  layout,
  s,
  entryId,
  acts,
  projectIds,
  hidden,
  allEntries,
  narrow,
  onMoreEntries,
}: {
  narrow: boolean;
  hidden: number;
  allEntries: boolean;
  onMoreEntries: () => void;
  spec: InsideSpec;
  layout: InsideLayout;
  s: UiState;
  entryId: string | null;
  acts: Acts;
  /** Labels of the workspace's projects, by name: a data box that is one opens it. */
  projectIds: ReadonlyMap<string, string>;
}) {
  const entry = entryId === null ? undefined : spec.entries.find((e) => e.id === entryId);
  const steps = entry === undefined ? [] : flowOf(spec, entry);
  const keys = new Set(steps.map((st) => st.key));
  const usedFns = new Set<string>();
  const usedData = new Set<string>();
  for (const st of steps) {
    if (st.kind === "entry") usedFns.add(st.to);
    else if (st.kind === "call") {
      usedFns.add(st.from);
      usedFns.add(st.to);
    } else {
      usedFns.add(st.from);
      const u = spec.uses.find((x) => x.fn === st.from && `d:${x.fn}>${x.data}` === st.key);
      if (u !== undefined) usedData.add(u.data);
    }
  }
  const cur = s.istep === null ? undefined : steps[s.istep]?.key;
  const dim = entry !== undefined;
  return (
    <>
      {layout.frames.map((f) => (
        <div
          key={f.svc}
          className="frame"
          style={{ left: layout.frameX, top: f.y, width: layout.frameW, height: f.h }}
        >
          <div className="ft">
            <Layers aria-hidden="true" strokeWidth={1.6} />
            {f.svc}
          </div>
        </div>
      ))}
      <svg className="wires" width={layout.w} height={layout.h} aria-hidden="true">
        {[...layout.routes].map(([key, pts]) => {
          const isData = key.startsWith("d:");
          const inTrace = keys.has(key);
          if (isData && !inTrace) return null;
          const cls = [
            "edge",
            `k-${isData ? "jobs" : "calls"}`,
            "t-code",
            dim && !inTrace ? "dim" : "",
            inTrace ? "tr" : "",
            cur === key ? "sel" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <g key={key} className={cls} data-ikey={key}>
              <path className="ln" d={roundPath(shorten(pts))} />
              <path className="ar" d={arrowOf(pts)} />
            </g>
          );
        })}
      </svg>
      {spec.entries.map((e) => {
        const p = layout.entries.get(e.id);
        if (p === undefined) return null;
        return (
          // biome-ignore lint/a11y/useSemanticElements: an entry holds a badge and a line of text
          <div
            key={e.id}
            role="button"
            tabIndex={0}
            data-entry={e.id}
            aria-label={`${e.label}, ${e.kind}. Show what happens.`}
            className={`node entry ${entryId === e.id ? "sel" : ""} ${dim && entryId !== e.id ? "dim" : ""}`}
            style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
            onClick={() => acts.pickEntry(e.id)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") acts.pickEntry(e.id);
            }}
          >
            <div className="e-l" title={e.label}>
              {e.label}
            </div>
            <div className="e-s">
              <span className="bdg">
                <TriggerIcon kind={e.kind} />
                {e.kind}
              </span>
              <span className="e-raw">
                {narrow
                  ? ""
                  : e.raw !== "" && !e.label.includes(e.raw)
                    ? e.raw
                    : !narrow && (e.kind === "HTTP" || e.kind === "TOOL" || e.kind === "SOCKET")
                      ? `${base(e.file)}:${e.line}`
                      : ""}
              </span>
            </div>
          </div>
        );
      })}
      {spec.fns.map((f) => {
        const p = layout.fns.get(f.id);
        if (p === undefined) return null;
        const picked = s.isel?.t === "fn" && s.isel.id === f.id;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a function box holds an icon and two lines of text
          <div
            key={f.id}
            role="button"
            tabIndex={0}
            data-fn={f.id}
            aria-label={`${f.id}, a function of ${f.service}.`}
            className={`node fn ${picked ? "sel" : ""} ${dim && !usedFns.has(f.id) ? "dim" : ""}`}
            style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
            onClick={() => acts.pickInside({ t: "fn", id: f.id })}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") acts.pickInside({ t: "fn", id: f.id });
            }}
          >
            <div className="fn-n" title={f.id}>
              <FileCode aria-hidden="true" strokeWidth={1.6} />
              <span className="fn-t" style={narrow ? { fontSize: 12 } : undefined}>
                {f.id.split(".").slice(-2).join(".")}
              </span>
            </div>
            {s.more && f.doc !== "" && <div className="n-sub">{f.doc}</div>}
          </div>
        );
      })}
      {(hidden > 0 || allEntries) && (
        <button
          type="button"
          className="entry-more"
          style={{ left: 0, top: layout.moreAt, width: layout.entries.values().next().value?.w ?? 184 }}
          onClick={onMoreEntries}
        >
          {allEntries ? "Show fewer entry points" : `Show ${hidden} more entry points`}
        </button>
      )}
      {spec.data.map((d) => {
        const p = layout.data.get(d.id);
        if (p === undefined) return null;
        const picked = s.isel?.t === "dn" && s.isel.id === d.id;
        const project = d.kind === "proj" ? projectIds.get(d.name) : undefined;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a data box holds an icon and two lines of text
          <div
            key={d.id}
            role="button"
            tabIndex={0}
            data-dn={d.id}
            aria-label={`${d.name}, ${d.sub}.`}
            className={`node dn ${d.kind} ${picked ? "sel" : ""} ${dim && !usedData.has(d.id) ? "dim" : ""}`}
            style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
            onClick={() =>
              project === undefined ? acts.pickInside({ t: "dn", id: d.id }) : acts.openProject(project)
            }
            onKeyDown={(ev) => {
              if (ev.key === "Enter") acts.pickInside({ t: "dn", id: d.id });
            }}
          >
            <div className="dn-t" style={narrow ? { fontSize: 12 } : undefined}>
              <DataIcon kind={d.kind} name={d.name} />
              <span>{d.name}</span>
            </div>
            <div className="n-sub" style={narrow ? { fontSize: 12, paddingLeft: 0 } : undefined}>
              {d.sub}
            </div>
          </div>
        );
      })}
      <div className="ov" style={{ width: layout.w, height: layout.h }}>
        {steps.map((st, i) => {
          const pos: Pt | undefined = layout.badge.get(st.key);
          if (pos === undefined) return null;
          return (
            <div
              key={st.key}
              className={`badge ${s.istep === i ? "cur" : ""}`}
              data-ib={i}
              style={{ left: pos[0], top: pos[1] }}
            >
              {i + 1}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** The icon of a data box: a datastore's logo or the database icon, an outside service's logo, a project's role icon. */
export function DataIcon({ kind, name }: { kind: "db" | "out" | "proj"; name: string }) {
  if (kind === "out") return <Logo name={name} />;
  if (kind === "proj") return <RoleIcon of="Service" />;
  return LOGOS[name] === undefined ? <Li n="database" /> : <Logo name={name} />;
}

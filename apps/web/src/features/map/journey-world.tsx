import type { JourneyView } from "@majhi/shared";
import type { JourneyLayout } from "./layout";
import type { Graph } from "./model";

/**
 * A journey as a sequence diagram: a header per box with a dashed lifeline, one numbered arrow per step.
 * The current step is lit, a step that needs a check is amber, and while playing the steps after it fade.
 */
export function JourneyWorld({
  graph,
  journey,
  layout,
  step,
  play,
  onStep,
}: {
  graph: Graph;
  journey: JourneyView;
  layout: JourneyLayout;
  step: number | null;
  play: boolean;
  onStep: (i: number) => void;
}) {
  const { w, h, actors, x, hw, head, row } = layout;
  const cur = journey.steps[step ?? -1];
  return (
    <>
      <svg
        className="wires"
        width={w}
        height={h}
        style={{ pointerEvents: "auto" }}
        role="img"
        aria-label={`${journey.name}, ${journey.steps.length} steps`}
      >
        {actors.map((p) => (
          <line key={p} className="jline" x1={x(p)} y1={head - 4} x2={x(p)} y2={h - 6} />
        ))}
        {journey.steps.map((s, i) => {
          const y = head + 30 + i * row + row / 2 - 10;
          const a = x(s.from);
          const b = x(s.to);
          const dir = b >= a ? 1 : -1;
          const isCur = step === i;
          const later = step !== null && play && i > step;
          const done = step !== null && play && i < step;
          const cls = [
            "jstep",
            s.check ? "t-check" : "",
            isCur ? "cur" : "",
            later ? "later" : "",
            done ? "done" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const x1 = a + dir * 12;
          const mx = (a + b) / 2;
          const lw = s.label.length * 6.4 + 16;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: steps are also reached with the arrow keys and the list on the right
            // biome-ignore lint/a11y/noStaticElementInteractions: an SVG group that is a hit target
            // biome-ignore lint/suspicious/noArrayIndexKey: a journey may use one line twice
            <g key={`${s.from}>${s.to}:${i}`} className={cls} data-step={i} onClick={() => onStep(i)}>
              <rect
                className={`jrow ${isCur ? "cur" : ""}`}
                x={-14}
                y={y - row / 2 + 4}
                width={w + 28}
                height={row - 8}
                rx={8}
              />
              <path className="ln" d={`M${x1} ${y} L${b - dir * 7} ${y}`} />
              <path className="ar" d={`M${b} ${y} l${-dir * 8} -4.2 v8.4z`} />
              <rect className="jlabbg" x={mx - lw / 2} y={y - 27} width={lw} height={20} rx={5} />
              <text className="jlab" x={mx} y={y - 13}>
                {s.label}
              </text>
              <g className="jnum">
                <circle cx={a} cy={y} r={10} />
                <text x={a} y={y + 4}>
                  {i + 1}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
      {actors.map((p) => {
        const n = graph.byId.get(p);
        const active = cur !== undefined && (cur.from === p || cur.to === p);
        return (
          <div
            key={p}
            className={`jhead ${step !== null && !active ? "dim" : ""}`}
            style={{ left: x(p) - hw / 2, top: 0, width: hw, height: head - 18 }}
          >
            <span className={`bdg ${n?.roleClass ?? ""}`} style={{ height: 18 }}>
              {n?.roleLabel ?? "Gone"}
            </span>
            <div className="n-name">{n?.label ?? p}</div>
          </div>
        );
      })}
    </>
  );
}

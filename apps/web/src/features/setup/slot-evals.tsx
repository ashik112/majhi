import type { EvalMetrics, SlotStatus } from "@majhi/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { useToast } from "@/components/ui/toast";
import { useDecisionSlots, useDecisionsStatus, useRunEvals } from "@/lib/decisions-queries";
import { describeError } from "@/lib/errors";

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? "-" : `${Math.round(n * 100)}%`;
const ms = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${n} ms`);

/** The numbers worth a glance, from the last labeled run, else the fixtures. */
function headline(s: SlotStatus): { metrics: EvalMetrics; from: "labels" | "fixtures" } | undefined {
  if (s.labeled !== undefined)
    return {
      metrics: s.calibration === undefined ? s.labeled.metrics : (s.labeled.heldOut ?? s.labeled.metrics),
      from: "labels",
    };
  if (s.fixtures !== undefined) return { metrics: s.fixtures.metrics, from: "fixtures" };
  return undefined;
}

/**
 * Which decisions Laya owns. A slot acts only after an eval on the owner's own labels shows it
 * reaches its target precision; until then it runs in shadow: answers are logged and compared, and
 * nothing acts on them.
 */
export function SlotEvals() {
  const slots = useDecisionSlots();
  const status = useDecisionsStatus();
  const run = useRunEvals();
  const toast = useToast();
  const cache = status.data?.cache;
  return (
    <DetailSection
      title="What Laya decides"
      note="A decision acts only when its eval on your own corrections and outcomes passes. Until then it runs in shadow: logged, compared, and ignored."
      actions={
        <Button
          size="sm"
          disabled={run.isPending}
          onClick={() =>
            run.mutate("all", {
              onSuccess: (reports) => toast(`Ran ${reports.length} evals`),
              onError: (e) => toast("Could not run the evals", { detail: describeError(e), tone: "error" }),
            })
          }
        >
          {run.isPending ? "Running" : "Run decision evals"}
        </Button>
      }
    >
      {slots.isError && <p className="m-0 text-sm text-red">{describeError(slots.error)}</p>}
      {cache !== undefined && cache.hits + cache.misses > 0 && (
        <p className="m-0 mb-2 text-xs text-fg-faint">
          Repeat questions answered from memory: {pct(cache.hitRate)} of {cache.hits + cache.misses}.
        </p>
      )}
      <ul aria-label="Decision slots" className="m-0 flex max-w-[960px] list-none flex-col p-0">
        {(slots.data ?? []).map((s) => (
          <SlotRow key={s.slot} s={s} />
        ))}
      </ul>
    </DetailSection>
  );
}

function SlotRow({ s }: { s: SlotStatus }) {
  const h = headline(s);
  const m = h?.metrics;
  const live = s.mode === "live";
  return (
    <li className="flex flex-col gap-0.5 border-t border-line py-2 text-sm first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
        <Badge tone={live ? "green" : "amber"}>{live ? "Owned by Laya" : "Shadow"}</Badge>
        <span className="tnum w-24 shrink-0 text-right text-xs text-fg-faint">
          {s.labels}/{s.labelsNeeded} labels
        </span>
      </div>
      {m === undefined ? (
        <p className="m-0 text-xs text-fg-faint">Not run yet.</p>
      ) : (
        <p className="m-0 text-xs text-fg-muted text-pretty">
          {h?.from === "fixtures" ? "Built-in examples" : "Your labels"}: accuracy {pct(m.accuracy)} (a guess
          of the commonest answer gets {pct(m.majorityBaseline)}), precision {pct(m.precision)} at{" "}
          {pct(m.coverage)} coverage, calibration error {pct(m.ece)}, same answer in both orders{" "}
          {pct(m.orderConsistency)}, {ms(m.latencyP50Ms)} typical, {ms(m.latencyP90Ms)} slowest tenth.
          {s.calibration !== undefined && ` ${s.calibration.reason}`}
        </p>
      )}
    </li>
  );
}

import type { SlotStatus } from "@majhi/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { useToast } from "@/components/ui/toast";
import { useDecisionSlots, useDecisionsStatus, useRunEvals } from "@/lib/decisions-queries";
import { describeError } from "@/lib/errors";

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? "" : `${Math.round(n * 100)}%`;

/** The accuracy worth a glance, from the last run on the owner's labels, else on the built-in examples. */
function accuracyOf(s: SlotStatus): { accuracy: number; from: "labels" | "fixtures" } | undefined {
  if (s.labeled !== undefined) {
    const m = s.calibration === undefined ? s.labeled.metrics : (s.labeled.heldOut ?? s.labeled.metrics);
    if (m.accuracy !== null) return { accuracy: m.accuracy, from: "labels" };
  }
  const m = s.fixtures?.metrics;
  return m === undefined || m.accuracy === null ? undefined : { accuracy: m.accuracy, from: "fixtures" };
}

type JobState = "decides" | "learning" | "off";

/** What Laya does for one job: it decides, it is still learning from examples, or it is off. */
function stateOf(s: SlotStatus, layaOn: boolean): JobState {
  if (!layaOn) return "off";
  return s.mode === "live" ? "decides" : "learning";
}

const STATE_LABEL: Record<JobState, string> = {
  decides: "Laya decides",
  learning: "Learning",
  off: "Off",
};

/**
 * Which jobs Laya does. A job starts when Laya is sure enough, or after it was checked on enough of
 * your corrections and outcomes; until then it only watches and learns, and majhi uses its own way.
 */
export function SlotEvals() {
  const slots = useDecisionSlots();
  const status = useDecisionsStatus();
  const run = useRunEvals();
  const toast = useToast();
  const cache = status.data?.cache;
  const layaOn = status.data?.providers.some((p) => p.id === "laya" && p.available) === true;
  const inOrder = status.data?.settings.order.includes("laya") === true;
  return (
    <DetailSection
      title="What Laya decides"
      note="Laya decides a job when it is sure. Until it has seen enough examples it only learns, and majhi does the job its own way."
      actions={
        <Button
          size="sm"
          disabled={run.isPending}
          onClick={() =>
            run.mutate("all", {
              onSuccess: (reports) => toast(`Checked ${reports.length} times`),
              onError: (e) => toast("Could not check Laya", { detail: describeError(e), tone: "error" }),
            })
          }
        >
          {run.isPending ? "Checking" : "Check now"}
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
          <SlotRow key={s.slot} s={s} layaOn={layaOn && inOrder} />
        ))}
      </ul>
    </DetailSection>
  );
}

const TONE: Record<JobState, "green" | "amber" | "neutral"> = {
  decides: "green",
  learning: "amber",
  off: "neutral",
};

function SlotRow({ s, layaOn }: { s: SlotStatus; layaOn: boolean }) {
  const state = stateOf(s, layaOn);
  const known = accuracyOf(s);
  return (
    <li className="flex flex-col gap-0.5 border-t border-line py-2 text-sm first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
        <Badge tone={TONE[state]}>{STATE_LABEL[state]}</Badge>
        <span className="tnum w-36 shrink-0 text-right text-xs text-fg-faint">
          {state === "learning" ? `${Math.min(s.labels, s.labelsNeeded)} of ${s.labelsNeeded} examples` : ""}
        </span>
      </div>
      {known !== undefined && (
        <p className="m-0 text-xs text-fg-muted text-pretty">
          Right {pct(known.accuracy)} of the time on{" "}
          {known.from === "fixtures" ? "built-in examples" : "your corrections"}.
          {s.calibration !== undefined && ` ${s.calibration.reason}`}
        </p>
      )}
      {s.regressed !== undefined && (
        <p className="m-0 text-xs text-red text-pretty">Got worse: {s.regressed}. A finding was filed.</p>
      )}
    </li>
  );
}

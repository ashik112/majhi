import type { EvalReport, SlotStatus } from "@majhi/shared";
import { errorMessage } from "../../errors.ts";
import type { RulesResult, RulesRunner } from "../../playbooks/rules.ts";
import type { SlotDef } from "../slots.ts";

/**
 * The weekly eval job (SPEC 5.12, "Weekly eval"): an Upkeep playbook of the rules kind. Once a week it runs
 * the eval harness over every slot's stored labels and built-in examples, which also refits each slot's
 * threshold on the labels it has now (a slot that no longer meets its target goes back to shadow, a
 * slot that now does goes live), and files a finding for each slot that got worse. It costs no model
 * tokens: Laya is local. The Hub's "What Laya decides" shows the same numbers and the same warning.
 */

/** A drop in precision (or accuracy) between two runs that counts as a regression, on labels. */
export const LABEL_DROP = 0.05;
/** On the built-in examples, which are few, one item moves the number by several points. */
export const FIXTURE_DROP = 0.1;
/** Answered items a run needs before its numbers say anything. */
export const MIN_ITEMS = 10;

const score = (r: EvalReport): number | null => {
  const m = r.heldOut ?? r.metrics;
  return m.precision ?? m.accuracy;
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Whether a slot got worse between its last two runs on one set, or is live and under its target. Runs
 * where Laya did not answer (no answered items) say nothing and never count. `history` is newest first.
 */
export function regressionOf(
  slot: Pick<SlotDef, "target">,
  live: boolean,
  history: readonly EvalReport[],
): { previous?: SlotStatus["previous"]; regressed?: string } {
  const [now, before] = history;
  if (now === undefined || (now.heldOut ?? now.metrics).n < MIN_ITEMS) return {};
  const current = score(now);
  // The best of the earlier runs that said something: a slot that stays bad week after week stays
  // regressed, and is only fine again when it gets back near where it was.
  let best: { score: number; at: string } | undefined;
  for (const r of history.slice(1)) {
    const s = score(r);
    if (s !== null && (r.heldOut ?? r.metrics).n >= MIN_ITEMS && (best === undefined || s > best.score)) {
      best = { score: s, at: r.at };
    }
  }
  const previous =
    before === undefined
      ? undefined
      : {
          at: before.at,
          accuracy: (before.heldOut ?? before.metrics).accuracy,
          precision: (before.heldOut ?? before.metrics).precision,
        };
  const drop = now.set === "labels" ? LABEL_DROP : FIXTURE_DROP;
  if (current !== null && best !== undefined && best.score - current >= drop - 1e-9) {
    return {
      ...(previous === undefined ? {} : { previous }),
      regressed: `fell from ${pct(best.score)} to ${pct(current)} since ${best.at.slice(0, 10)}`,
    };
  }
  if (live && current !== null && current < slot.target - 0.02) {
    return {
      ...(previous === undefined ? {} : { previous }),
      regressed: `is live at ${pct(current)}, under its target of ${pct(slot.target)}`,
    };
  }
  return previous === undefined ? {} : { previous };
}

/** What the job needs of the decision service. */
export interface LayaEvalPort {
  runEvals(use: string): Promise<EvalReport[]>;
  slots(): SlotStatus[];
}

/** What the job needs of the findings store, besides what the playbook run gives it. */
export interface BacklogPort {
  triageBacklog(limit: number): Promise<number>;
}

/** Findings a week's job may triage from before triage existed. */
export const BACKLOG_PER_RUN = 40;

export function layaEvalRunner(deps: { decisions: LayaEvalPort; backlog?: BacklogPort }): RulesRunner {
  return {
    async run(ctx): Promise<RulesResult> {
      const before = new Map(deps.decisions.slots().map((s) => [s.slot, s.mode]));
      try {
        await deps.decisions.runEvals("all");
      } catch (err) {
        // The harness failing is the job failing: the playbook backs off and the owner hears after two.
        throw new Error(`the evals did not run: ${errorMessage(err)}`);
      }
      const now = deps.decisions.slots();
      let filed = 0;
      let worse = 0;
      let recalibrated = 0;
      for (const s of now) {
        const key = `laya-regression:${s.slot}`;
        const demoted = before.get(s.slot) === "live" && s.mode === "shadow";
        if (before.get(s.slot) !== undefined && before.get(s.slot) !== s.mode) recalibrated += 1;
        const why =
          s.regressed ??
          (demoted ? "went back to shadow: its new fit no longer meets its target" : undefined);
        if (why === undefined) {
          const open = ctx.findings.find(ctx.org, key);
          if (open !== undefined && open.status === "open") {
            ctx.findings.update({ id: open.id, status: "fixed" }, { kind: "captain", org: ctx.org });
            filed += 1;
          }
          continue;
        }
        worse += 1;
        if (ctx.rulesOff?.has("laya-finding") === true) continue;
        await ctx.findings.report(
          {
            org: ctx.org,
            source: "setup",
            title: `Laya got worse at: ${s.title}`,
            detail: `${s.title} ${why}. ${
              s.mode === "live"
                ? "It still acts. Check Hub, Setup, What Laya decides, and correct what it got wrong."
                : "It acts on nothing now: the old way is back until it is calibrated again."
            }`,
            evidence: [`slot ${s.slot}`, `${s.labels} labels`],
            severity: s.mode === "live" ? "medium" : "low",
            playbook: ctx.playbook.id,
            dedupeKey: key,
          },
          { kind: "captain", org: ctx.org },
        );
        filed += 1;
      }
      // Findings from before triage existed get their read too, a few at a time.
      const triaged =
        ctx.rulesOff?.has("laya-backlog") === true
          ? 0
          : ((await deps.backlog?.triageBacklog(BACKLOG_PER_RUN).catch(() => 0)) ?? 0);
      const note = `${now.length} slots checked, ${worse} worse, ${recalibrated} changed mode${triaged > 0 ? `, ${triaged} old findings read` : ""}`;
      return { findings: filed, note };
    },
  };
}

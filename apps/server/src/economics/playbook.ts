import type { EconomicsFlagKind } from "@majhi/shared";
import { FOLDED } from "../outcomes/derive.ts";
import type { RulesContext, RulesResult, RulesRunner } from "../playbooks/rules.ts";
import { isoWeek } from "./compute.ts";
import { type EconomicsService, rowLine } from "./service.ts";

/**
 * The "Client economics" playbook: once a week, in each workspace, it reads the economics (code, no
 * model) and files one `analysis` finding per flag. A finding is deduplicated per workspace, flag and
 * week, so a Monday run that is repeated adds nothing. The week before's finding of a flag that still
 * holds is folded into this week's; one whose flag cleared is closed as fixed.
 */

const TITLE: Record<EconomicsFlagKind, (name: string) => string> = {
  "spend-outpaces-work": (n) => `${n}: spend is growing faster than shipped work`,
  quiet: (n) => `${n}: nothing has shipped in two weeks`,
  "near-budget": (n) => `${n}: spend is near the retainer`,
};

const SEVERITY: Record<EconomicsFlagKind, "low" | "medium"> = {
  "spend-outpaces-work": "medium",
  quiet: "low",
  "near-budget": "medium",
};

export function economicsKey(org: string, kind: EconomicsFlagKind, week: string): string {
  return `economics:${org}:${kind}:${week}`;
}

export function economicsRunner(
  economics: EconomicsService,
  orgName: (org: string) => Promise<string>,
): RulesRunner {
  return {
    async run(ctx: RulesContext): Promise<RulesResult> {
      const data = await economics.get("week", ctx.org);
      const row = data.rows.find((r) => r.org === ctx.org);
      if (row === undefined) return { findings: 0, note: "No activity yet" };
      const name = await orgName(ctx.org);
      const week = isoWeek(ctx.now());
      const actor = { kind: "captain" as const, org: ctx.org };
      const live = ctx.findings.list({ org: ctx.org, source: "analysis", status: "live", limit: 200 }, actor)
        .findings;
      const mine = live.filter((f) => f.dedupeKey.startsWith(`economics:${ctx.org}:`));
      const thisWeek = new Set<string>();
      let filed = 0;
      for (const flag of row.flags) {
        const key = economicsKey(ctx.org, flag.kind, week);
        thisWeek.add(key);
        await ctx.findings.report(
          {
            org: ctx.org,
            source: "analysis",
            title: TITLE[flag.kind](name),
            detail: `${flag.text}\n${data.label}: ${rowLine(row)}.`,
            evidence: [`economics.get week ${week}`],
            severity: SEVERITY[flag.kind],
            playbook: ctx.playbook.id,
            dedupeKey: key,
          },
          actor,
        );
        filed += 1;
      }
      for (const old of mine) {
        if (thisWeek.has(old.dedupeKey)) continue;
        const kind = old.dedupeKey.split(":")[2];
        const again = row.flags.some((f) => f.kind === kind);
        try {
          if (again) ctx.findings.dismiss(old.id, `${FOLDED} this week's`, actor);
          else ctx.findings.update({ id: old.id, status: "fixed" }, actor);
        } catch {
          // A finding the owner moved meanwhile stays as it is.
        }
      }
      return {
        findings: filed,
        note: filed === 0 ? `Nothing to flag: ${rowLine(row)}` : `${filed} flagged: ${rowLine(row)}`,
      };
    },
  };
}

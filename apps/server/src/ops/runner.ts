import type { RulesRunner } from "../playbooks/rules.ts";
import type { OpsWatch } from "./watch.ts";

/**
 * The ops watch as a rules playbook (cost tier "rules": code, no model). The scheduler keeps the
 * cadence, the switch and the history; the watch keeps the services, the counts and the incidents.
 */
export function opsRunners(watch: OpsWatch): Record<string, RulesRunner> {
  return {
    uptime: {
      async run(ctx) {
        // An older uptime check listed its addresses as a setting: they become services, once.
        const legacy = ctx.settings.urls ?? [];
        if (legacy.length > 0) watch.importUrls(ctx.org, legacy);
        return watch.runOrg(ctx.org, ctx.manual === true);
      },
    },
  };
}

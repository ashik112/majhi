import type { AutonomyMode, AutonomySettings, CaptainPolicy } from "@majhi/shared";
import { zoneOr } from "../usage/ranges.ts";
import { authorityOf } from "./levels.ts";

/**
 * The one place that builds the value `may` reads (`CaptainPolicy`) from the settings as they are saved
 * today: the workspace's authority rows, its hours, freezes and zone. Callers pass the settings and the two
 * live switches and never read the fields themselves. When the settings move into one captain-policy
 * section, this function and the schema are all that change.
 */
export function captainPolicyOf(
  settings: Pick<AutonomySettings, "orgs" | "tz">,
  org: string,
  live: { name: string; autopilot: AutonomyMode; stopped: boolean },
): CaptainPolicy {
  const rules = settings.orgs[org];
  return {
    name: live.name,
    authority: authorityOf(settings, org),
    autopilot: live.autopilot,
    stopped: live.stopped,
    hours: rules?.hours,
    freeze: rules?.freeze,
    tz: zoneOr(rules?.tz ?? settings.tz),
  };
}

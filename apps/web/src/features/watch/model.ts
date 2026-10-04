import type {
  OpsCheckKind,
  OpsCheckStatus,
  OpsIncident,
  OpsServiceView,
  OpsTimelineEntry,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";

/** Words and lamps for the ops watch. One lamp colour per state, always with its word (DESIGN.md, Lamp Law). */

export const CHECK_LAMP: Record<OpsCheckStatus, LampState> = {
  up: "done",
  checking: "paused",
  down: "needs",
  unknown: "idle",
  new: "idle",
};

export const CHECK_WORD: Record<OpsCheckStatus, string> = {
  up: "Up",
  checking: "Checking",
  down: "Down",
  unknown: "Unknown",
  new: "Not checked yet",
};

export const KIND_LABEL: Record<OpsCheckKind, string> = {
  url: "Address",
  monitor: "Monitor",
  dns: "Name",
  tls: "Certificate",
};

/** An open incident: red when it is high, magenta when it is not, green once resolved. */
export function incidentLamp(i: Pick<OpsIncident, "status" | "severity">): LampState {
  if (i.status === "resolved") return "done";
  return i.severity === "high" ? "needs" : "paused";
}

export function incidentWord(i: Pick<OpsIncident, "status" | "severity" | "ackedAt">): string {
  if (i.status === "resolved") return "Resolved";
  if (i.ackedAt !== undefined) return "Acknowledged";
  return i.severity === "high" ? "Needs you" : "Open";
}

export const TIMELINE_LABEL: Record<OpsTimelineEntry["kind"], string> = {
  opened: "Opened",
  alerted: "Alert",
  escalated: "Alert again",
  acked: "Acknowledged",
  action: "Captain",
  reopened: "Failing again",
  resolved: "Resolved",
  note: "Also",
};

/** "12 min", "3 h 5 min", "2 d". */
export function spanText(fromIso: string, toMs: number): string {
  const min = Math.max(0, Math.round((toMs - Date.parse(fromIso)) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
  return `${Math.round(h / 24)} d`;
}

/** The workspace's services, with the services that are not up first. */
export function byWorkspace(
  services: readonly OpsServiceView[],
): { org: string; services: OpsServiceView[] }[] {
  const order = { down: 0, checking: 1, unknown: 2, new: 3, up: 4 } as const;
  const groups = new Map<string, OpsServiceView[]>();
  for (const s of services) groups.set(s.org, [...(groups.get(s.org) ?? []), s]);
  return [...groups.entries()].map(([org, list]) => ({
    org,
    services: list.toSorted(
      (a, b) => order[a.status] - order[b.status] || a.def.name.localeCompare(b.def.name),
    ),
  }));
}

/** The headline under the page title. */
export function summary(services: readonly OpsServiceView[], open: number): string {
  if (services.length === 0 && open === 0) return "Services you list are checked for you";
  const down = services.filter((s) => s.status === "down").length;
  const parts: string[] = [];
  if (services.length > 0) {
    parts.push(
      down === 0
        ? `${services.length} ${services.length === 1 ? "service" : "services"}, all up`
        : `${down} of ${services.length} down`,
    );
  }
  if (open > 0) parts.push(`${open} ${open === 1 ? "incident" : "incidents"} open`);
  return parts.join(" · ");
}

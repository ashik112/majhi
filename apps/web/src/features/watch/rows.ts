import type { OpsIncident, OpsServiceView, WatchSort, WatchStatus, WatchView } from "@majhi/shared";
import {
  Activity,
  Anchor,
  BadgeDollarSign,
  Database,
  FolderGit2,
  Gauge,
  GitBranch,
  GitPullRequest,
  Globe,
  ListChecks,
  type LucideIcon,
  Package,
  Server,
  Sparkles,
  SquareTerminal,
  Workflow,
  Zap,
} from "lucide-react";
import type { LampState } from "@/components/ui/lamp";

/** One line of the Watch list: a watch, a service watched the older way, or one of majhi's own incidents. */
export type RowSort = WatchSort | "majhi";

export interface Row {
  key: string;
  sort: RowSort;
  name: string;
  org: string;
  /** The value as the row shows it. */
  value: string;
  status: WatchStatus;
  /** One word beside the lamp. */
  word: string;
  watch?: WatchView;
  service?: OpsServiceView;
  incident?: OpsIncident;
}

export const SORT_ICON: Record<RowSort, LucideIcon> = {
  website: Globe,
  database: Database,
  redis: Zap,
  server: Server,
  queue: Package,
  price: BadgeDollarSign,
  metric: Activity,
  path: FolderGit2,
  task: ListChecks,
  mr: GitPullRequest,
  branch: GitBranch,
  process: Workflow,
  usage: Gauge,
  command: SquareTerminal,
  custom: Sparkles,
  majhi: Anchor,
};

export const STATUS_LAMP: Record<WatchStatus, LampState> = {
  ok: "done",
  alerting: "needs",
  changed: "needs",
  paused: "paused",
  unknown: "idle",
  new: "idle",
};

export function watchRow(w: WatchView): Row {
  return {
    key: w.id,
    sort: w.def.spec.kind,
    name: w.def.name,
    org: w.org,
    value: w.value,
    status: w.status,
    word: w.word,
    watch: w,
  };
}

export function serviceRow(s: OpsServiceView): Row {
  const url = s.checks.find((c) => c.kind === "url");
  const warn = s.checks.find((c) => (c.kind === "tls" || c.kind === "dns") && c.status !== "up");
  const status: WatchStatus =
    s.status === "down" ? "alerting" : s.status === "unknown" ? "unknown" : s.status === "new" ? "new" : "ok";
  return {
    key: s.id,
    sort: "website",
    name: s.def.name,
    org: s.org,
    value: warn?.detail ?? url?.detail ?? "not checked yet",
    status,
    word:
      s.status === "down"
        ? "Down"
        : s.status === "up"
          ? "Up"
          : s.status === "unknown"
            ? "Unknown"
            : "Checking",
    service: s,
  };
}

export function selfRow(i: OpsIncident): Row {
  return {
    key: `inc-${i.id}`,
    sort: "majhi",
    name: i.title,
    org: i.org,
    value: "",
    status: "alerting",
    word: i.ackedAt === undefined ? "Open" : "Acknowledged",
    incident: i,
  };
}

/** Rows that need you first, then the rest by name. */
export function sortRows(rows: readonly Row[]): Row[] {
  const rank: Record<WatchStatus, number> = { alerting: 0, changed: 0, unknown: 1, new: 2, paused: 3, ok: 4 };
  return rows.toSorted((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

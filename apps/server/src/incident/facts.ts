import type {
  DeployRecord,
  IncidentEvent,
  OpsIncident,
  StatusFacts,
  Task,
} from "@majhi/shared";
import type { FindingsService } from "../findings/service.ts";
import type { Store } from "../store/index.ts";

/**
 * What is recorded about one incident, read at one moment. The one reader of an incident's facts: the client updates,
 * the report, the resolution and the owner's cards all read it, so they cannot disagree.
 */

export interface FactsDeps {
  store: Store;
  findings: Pick<FindingsService, "ofTask">;
  watch: {
    incident(id: number): OpsIncident | undefined;
    incidentOfFinding(finding: number): OpsIncident | undefined;
  };
  /** The workspace's soak and update cadence. */
  settings: (org: string) => Promise<{ soakMin: number; cadenceMin: number }>;
  /** How many deploy environments a project has: none means a merge ships it. */
  envs: (project: string) => Promise<number>;
  now?: (() => Date) | undefined;
}

export interface IncidentRead {
  task: Task;
  org: string;
  /** The tasks made to fix it: its children and its fix tasks. */
  fixes: Task[];
  deploys: DeployRecord[];
  events: { id: string; detail: IncidentEvent }[];
  watch: OpsIncident | undefined;
  facts: StatusFacts;
  cadenceMin: number;
}

export const earliest = (times: readonly (string | undefined)[]): string | undefined =>
  times.filter((t): t is string => t !== undefined).toSorted()[0];
export const latest = (times: readonly (string | undefined)[]): string | undefined =>
  times
    .filter((t): t is string => t !== undefined)
    .toSorted()
    .at(-1);

export class IncidentFacts {
  constructor(private readonly deps: FactsDeps) {}

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  events(task: string): IncidentRead["events"] {
    return this.deps.store.room
      .ofType(task, "incident-event")
      .flatMap((i) => (i.type === "incident-event" ? [{ id: i.id, detail: i.detail }] : []));
  }

  /** The watch incident this task is the task of: through its finding, or the one it was made for. */
  watchOf(task: Task): OpsIncident | undefined {
    const findings = new Set(this.deps.findings.ofTask(task.id).map((f) => f.id));
    if (task.origin?.kind === "finding") findings.add(task.origin.finding);
    const found: OpsIncident[] = [];
    for (const f of findings) {
      const incident = this.deps.watch.incidentOfFinding(f);
      if (incident !== undefined) found.push(incident);
    }
    if (task.origin?.kind === "watch" && task.origin.incident !== undefined) {
      const incident = this.deps.watch.incident(task.origin.incident);
      if (incident !== undefined) found.push(incident);
    }
    return found.toSorted((a, b) => b.id - a.id)[0];
  }

  /** The tasks made to fix the incident: its children and its fix tasks. */
  fixTasks(task: string): Task[] {
    const ids = this.deps.store.tasks
      .linksTo(task)
      .filter((l) => l.type === "parent" || l.type === "follow-up")
      .map((l) => l.task);
    return ids.flatMap((id) => this.deps.store.tasks.get(id) ?? []);
  }

  /** The newest deploy of each environment: an older failed one the fix replaced is no longer pending. */
  private newest(deploys: readonly DeployRecord[]): DeployRecord[] {
    const by = new Map<string, DeployRecord>();
    for (const d of deploys) {
      const key = `${d.project}:${d.env}`;
      const seen = by.get(key);
      if (seen === undefined || d.createdAt >= seen.createdAt) by.set(key, d);
    }
    return [...by.values()];
  }

  async read(task: Task): Promise<IncidentRead> {
    const org = task.org ?? "";
    const settings = await this.deps.settings(org);
    const fixes = this.fixTasks(task.id);
    const all = [task, ...fixes];
    const deploys = all.flatMap((t) => this.deps.store.deploys.ofTask(t.id));
    const events = this.events(task.id);
    const watch = this.watchOf(task);
    const cause = earliest(events.flatMap((e) => (e.detail.event === "cause" ? [e.detail.at] : [])));
    const reopenedAt = events.flatMap((e) => (e.detail.event === "reopened" ? [e.detail.at] : []));
    const identifiedAt = earliest([
      cause,
      ...fixes.map((t) => t.createdAt),
      ...all.flatMap((t) => t.repos.flatMap((r) => [r.pushedAt, r.landed?.at])),
      ...deploys.map((d) => d.createdAt),
    ]);
    const current = this.newest(deploys);
    const pending = current.some((d) => d.state !== "live");
    let liveAt: string | undefined;
    if (deploys.length > 0) {
      if (!pending) liveAt = latest(current.map((d) => d.finishedAt ?? d.updatedAt));
    } else {
      // A project with no environments ships when its work is merged.
      const merged: (string | undefined)[] = [];
      for (const t of all) {
        for (const r of t.repos) {
          if ((await this.deps.envs(r.project)) === 0) merged.push(r.landed?.at);
        }
      }
      liveAt = latest(merged);
    }
    const facts: StatusFacts = {
      openedAt: task.createdAt,
      reopenedAt,
      ...(identifiedAt === undefined ? {} : { identifiedAt }),
      ...(liveAt === undefined ? {} : { liveAt }),
      ...(watch === undefined
        ? {}
        : {
            watch: {
              ...(watch.status === "resolved" ? { greenAt: watch.resolvedAt ?? watch.openedAt } : {}),
            },
          }),
      ...(task.status === "done" ? { doneAt: task.updatedAt } : {}),
      deploysPending: pending,
      soakMin: settings.soakMin,
      now: this.now().toISOString(),
    };
    return { task, org, fixes, deploys, events, watch, facts, cadenceMin: settings.cadenceMin };
  }
}

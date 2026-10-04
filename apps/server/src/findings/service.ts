import {
  canMoveFinding,
  FINDING_LIVE,
  FINDING_SOURCE_LABEL,
  type Finding,
  type FindingReportInput,
  type FindingReportResult,
  type FindingSource,
  type FindingStatus,
  type FindingsList,
  type FindingsListInput,
  type FindingToTaskResult,
  type FindingUpdateInput,
  PRIVATE,
  type TaskStatus,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { FindingsRepo } from "./repo.ts";

/**
 * Findings (SPEC 5.18): the one deduplicated store for what playbooks and agents notice. Pure rules
 * over the repo; majhi's tasks come in through `deps`.
 */

/** Who acts. A captain lane and an agent are tied to one workspace. */
export type FindingActor =
  | { kind: "owner" }
  | { kind: "captain"; org?: string | undefined }
  | { kind: "agent"; id: string; org: string };

export interface FindingsDeps {
  repo: FindingsRepo;
  now?: () => Date;
  /** Makes the finding's task in the inbox, not started. */
  createTask(input: {
    org: string;
    project?: string | undefined;
    title: string;
    text: string;
    byOwner: boolean;
    /** A change to code, whatever the words say: an incident's fix reads "is down" but is not an investigation. */
    code?: boolean;
  }): Promise<{ id: string }>;
  /** A task's status, undefined when it is gone. */
  taskStatus(id: string): TaskStatus | undefined;
  /** The workspace a project belongs to, undefined for an unknown project. */
  projectOrg(project: string): Promise<string | undefined>;
  /** Tells the screens. */
  changed?: () => void;
  /** A finding is new, or came back after it was fixed: the workspace's captain lane hears of it. */
  appeared?: (finding: Finding) => void;
}

const DAY_MS = 86_400_000;
const MAX_EVIDENCE = 20;

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3 } as const;

/** The key two reports share when none is given: source, project and the title without case or spacing. */
export function defaultDedupeKey(input: Pick<FindingReportInput, "source" | "project" | "title">): string {
  const title = input.title.toLowerCase().replace(/\s+/g, " ").trim();
  return `${input.source}:${input.project ?? "-"}:${title}`;
}

export class FindingsService {
  private readonly repo: FindingsRepo;

  constructor(private readonly deps: FindingsDeps) {
    this.repo = deps.repo;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private at(): string {
    return this.now().toISOString();
  }

  /** The workspace an actor reports or reads in: its own, or the one asked for. */
  private scopeOf(actor: FindingActor, asked: string | undefined): string | undefined {
    if (actor.kind === "agent") return actor.org;
    if (actor.kind === "captain" && actor.org !== undefined) return actor.org;
    return asked;
  }

  private reach(actor: FindingActor, finding: Finding): void {
    const own = actor.kind === "owner" ? undefined : this.scopeOf(actor, undefined);
    if (own !== undefined && finding.org !== own) {
      throw new UserError(`Finding ${finding.id} belongs to another workspace.`, 409);
    }
  }

  /** An agent changes only what it reported itself. */
  private mayChange(actor: FindingActor, finding: Finding): void {
    this.reach(actor, finding);
    if (actor.kind === "agent" && finding.by !== actor.id) {
      throw new UserError(
        `Finding ${finding.id} was reported by ${finding.by}. An agent changes only its own.`,
        409,
      );
    }
  }

  /** The finding with this dedupe key in a workspace, if any. */
  find(org: string, key: string): Finding | undefined {
    return this.repo.byKey(org, key);
  }

  /** The live findings of a project and source whose dedupe key starts with `prefix`: a sensor closes the ones it no longer sees. */
  liveWithPrefix(org: string, project: string, source: FindingSource, prefix: string): Finding[] {
    return this.repo
      .list({ org, project, source, statuses: FINDING_LIVE, limit: 5_000 })
      .filter((f) => f.dedupeKey.startsWith(prefix));
  }

  /** How many findings a playbook filed, and how many were taken up or dismissed. */
  statsOf(org: string, playbook: string): { total: number; accepted: number; dismissed: number } {
    return this.repo.statsByPlaybook(org, playbook);
  }

  /** How many findings a playbook filed or refreshed since a time. */
  countSince(org: string, playbook: string, since: string): number {
    return this.repo.countSince(org, playbook, since);
  }

  /** Whether a finding exists, for a deadline that links to one. */
  exists(id: number): boolean {
    return this.repo.get(id) !== undefined;
  }

  get(id: number): Finding {
    const found = this.repo.get(id);
    if (found === undefined) throw new UserError(`Finding ${id} does not exist.`, 404);
    return found;
  }

  /** Creates a finding, or refreshes the one with the same dedupe key. */
  async report(input: FindingReportInput, actor: FindingActor): Promise<FindingReportResult> {
    const org = this.scopeOf(actor, input.org) ?? PRIVATE;
    if (input.project !== undefined) {
      const owner = await this.deps.projectOrg(input.project);
      if (owner === undefined) throw new UserError(`Project ${input.project} does not exist.`, 404);
      if (owner !== org) throw new UserError(`Project ${input.project} belongs to another workspace.`, 409);
    }
    const key = input.dedupeKey ?? defaultDedupeKey(input);
    const at = this.at();
    const known = this.repo.byKey(org, key);
    if (known === undefined) {
      const added = this.repo.add({
        org,
        ...(input.project === undefined ? {} : { project: input.project }),
        source: input.source,
        title: input.title,
        detail: input.detail,
        evidence: input.evidence.slice(0, MAX_EVIDENCE),
        severity: input.severity,
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.playbook === undefined ? {} : { playbook: input.playbook }),
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        dedupeKey: key,
        by: actor.kind === "agent" ? actor.id : actor.kind,
        at,
      });
      this.deps.changed?.();
      this.deps.appeared?.(added);
      return { finding: added, result: "created" };
    }
    // The same finding again: last seen moves, evidence joins, severity only rises. A dismissed one stays so.
    const evidence = [...new Set([...known.evidence, ...input.evidence])].slice(0, MAX_EVIDENCE);
    const reopen = known.status === "fixed";
    const refreshed = this.repo.patch(known.id, {
      at,
      lastSeen: at,
      seen: known.seen + 1,
      evidence,
      ...(input.detail !== "" && input.detail !== known.detail ? { detail: input.detail } : {}),
      ...(SEVERITY_RANK[input.severity] > SEVERITY_RANK[known.severity] ? { severity: input.severity } : {}),
      ...(reopen ? { status: "open" as const, task: null, decision: null } : {}),
    });
    this.deps.changed?.();
    if (reopen) this.deps.appeared?.(refreshed);
    return { finding: refreshed, result: reopen ? "reopened" : "refreshed" };
  }

  /** The open findings of a workspace for the captain's digest: worst first, at most `max`. */
  digestLines(org: string, max = 6): string[] {
    const open = this.repo.list({ org, statuses: ["open"], limit: 200 });
    const rank = { high: 3, medium: 2, low: 1, info: 0 } as const;
    return open
      .toSorted((a, b) => rank[b.severity] - rank[a.severity] || b.id - a.id)
      .slice(0, max)
      .map((f) => `#${f.id} [${f.severity}] ${f.title}${f.project === undefined ? "" : ` (${f.project})`}`);
  }

  /** How many findings of a workspace are open. */
  openCount(org: string): number {
    return this.repo.list({ org, statuses: ["open"], limit: 500 }).length;
  }

  list(input: FindingsListInput, actor: FindingActor): FindingsList {
    this.sync();
    const org = this.scopeOf(actor, input.org);
    const statuses =
      input.status === undefined ? undefined : input.status === "live" ? FINDING_LIVE : [input.status];
    const findings = this.repo.list({
      org,
      project: input.project,
      source: input.source,
      statuses,
      limit: input.limit,
    });
    const open = this.repo.list({ org, statuses: ["open"], limit: 500 });
    const since = this.now().getTime() - DAY_MS;
    return {
      findings,
      open: open.length,
      fresh: open.filter((f) => Date.parse(f.createdAt) >= since).length,
    };
  }

  update(input: FindingUpdateInput, actor: FindingActor): Finding {
    const found = this.get(input.id);
    this.mayChange(actor, found);
    const to = input.status;
    if (to !== undefined && !canMoveFinding(found.status, to)) {
      throw new UserError(`A ${found.status} finding cannot become ${to}.`, 409);
    }
    if (to === "task" && input.task === undefined && found.task === undefined) {
      throw new UserError("Say which task: a finding that is a task points at one.", 400);
    }
    if (to === "decision" && input.decision === undefined && found.decision === undefined) {
      throw new UserError("Say which decision: a finding that is a decision points at one.", 400);
    }
    const out = this.repo.patch(input.id, {
      at: this.at(),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      ...(to === undefined ? {} : { status: to }),
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      // Back to open: the links and the dismissal reason no longer apply.
      ...(to === "open" ? { task: null, decision: null, dismissedReason: null } : {}),
    });
    this.deps.changed?.();
    return out;
  }

  dismiss(id: number, reason: string, actor: FindingActor): Finding {
    const found = this.get(id);
    this.mayChange(actor, found);
    if (found.status === "dismissed" || !canMoveFinding(found.status, "dismissed")) {
      throw new UserError(`A ${found.status} finding cannot be dismissed.`, 409);
    }
    const out = this.repo.patch(id, { at: this.at(), status: "dismissed", dismissedReason: reason });
    this.deps.changed?.();
    return out;
  }

  /**
   * Makes a task for the finding in its workspace. The owner's task goes to the inbox as theirs. The
   * captain only proposes (SPEC 5.18, Own work): the task waits in the inbox, not started, and the
   * finding says `proposed`. An agent does not make tasks from findings.
   */
  async toTask(id: number, actor: FindingActor): Promise<FindingToTaskResult> {
    if (actor.kind === "agent") {
      throw new UserError("Only the owner and the captain make tasks from findings.", 409);
    }
    const found = this.get(id);
    this.reach(actor, found);
    if (found.task !== undefined && (found.status === "proposed" || found.status === "task")) {
      throw new UserError(`Finding ${id} already has a task: ${found.task}.`, 409);
    }
    const to: FindingStatus = actor.kind === "owner" ? "task" : "proposed";
    if (!canMoveFinding(found.status, to)) {
      throw new UserError(`A ${found.status} finding cannot become a task.`, 409);
    }
    const task = await this.deps.createTask({
      org: found.org,
      project: found.project,
      title: found.title,
      text: taskText(found),
      byOwner: actor.kind === "owner",
      ...(found.source === "incident" ? { code: true } : {}),
    });
    const finding = this.repo.patch(id, { at: this.at(), status: to, task: task.id });
    this.deps.changed?.();
    return { finding, task: task.id };
  }

  /** Follows the linked tasks: a proposal the owner started is a task, a finished task fixed the finding. */
  sync(): void {
    let changed = false;
    for (const f of this.repo.linked()) {
      if (f.task === undefined) continue;
      const status = this.deps.taskStatus(f.task);
      if (status === undefined) {
        this.repo.patch(f.id, { at: this.at(), status: "open", task: null });
        changed = true;
      } else if (status === "done") {
        this.repo.patch(f.id, { at: this.at(), status: "fixed" });
        changed = true;
      } else if (f.status === "proposed" && status !== "inbox") {
        this.repo.patch(f.id, { at: this.at(), status: "task" });
        changed = true;
      }
    }
    if (changed) this.deps.changed?.();
  }
}

/** The brief of a task made from a finding: what was noticed, the evidence, where it came from. */
export function taskText(f: Finding): string {
  const lines = [f.detail === "" ? f.title : f.detail];
  if (f.evidence.length > 0) lines.push("", "Evidence:", ...f.evidence.map((e) => `- ${e}`));
  lines.push("", `Found by the captain (${FINDING_SOURCE_LABEL[f.source].toLowerCase()}), finding ${f.id}.`);
  return lines.join("\n");
}

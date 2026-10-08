import type { HandoffState, HomeBackground, HomeCheck, MergeChecks } from "@majhi/shared";

export interface HomeChecksDeps {
  /** Tasks in review: the ones whose rows show a check. */
  ids(): string[];
  /** The merge gate's verdict for the task's head now. */
  mergeChecks(id: string): Promise<MergeChecks>;
  state(id: string): Promise<HandoffState>;
  /** The task changed no code, so there is nothing to merge. */
  empty?(id: string): Promise<boolean>;
  /** The agent's last message in the task, whole. */
  lastMessage(id: string): string | undefined;
  now?: () => number;
}

/** Events invalidate local changes; this also bounds staleness for edits made outside majhi. */
const REUSE_MS = 20_000;

/** The first sentence of a message, on one line and short: what the agent says it did. */
export function firstSentence(text: string | undefined): string | undefined {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  const end = flat.search(/[.!?](\s|$)/);
  const one = end === -1 ? flat : flat.slice(0, end + 1);
  return one.length > 140 ? `${one.slice(0, 139)}…` : one;
}

/**
 * The checks of every review task in one read, for Home: the merge gate's verdict and what the
 * hand-off is doing, in one batch instead of a read per row.
 */
export class HomeChecks {
  private readonly kept = new Map<string, { at: number; row: HomeCheck }>();
  private pending: Promise<{ checks: HomeCheck[]; background: HomeBackground[] }> | undefined;
  // Replacing this token prevents a read started before a change from populating the cache.
  private revision = {};

  invalidate(ids?: readonly string[]): void {
    this.revision = {};
    if (ids === undefined) this.kept.clear();
    else for (const id of ids) this.kept.delete(id);
  }

  constructor(private readonly deps: HomeChecksDeps) {}

  async facts(): Promise<{ checks: HomeCheck[]; background: HomeBackground[] }> {
    if (this.pending !== undefined) return this.pending;
    const pending = this.read();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async read(): Promise<{ checks: HomeCheck[]; background: HomeBackground[] }> {
    const now = this.deps.now?.() ?? Date.now();
    const ids = this.deps.ids();
    const present = new Set(ids);
    for (const id of this.kept.keys()) if (!present.has(id)) this.kept.delete(id);
    const rows: (HomeCheck | undefined)[] = new Array(ids.length);
    let next = 0;
    // Bound Git subprocesses even when many tasks enter review together.
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length) {
          const index = next++;
          const id = ids[index];
          if (id !== undefined) rows[index] = await this.one(id, now);
        }
      }),
    );
    const checks: HomeCheck[] = [];
    const background: HomeBackground[] = [];
    for (const check of rows) {
      if (check === undefined) continue;
      checks.push(check);
      const a = check.activity;
      if (a === undefined) continue;
      background.push(
        a.phase === "queued"
          ? {
              task: check.task,
              kind: "queued-check",
              label: "checks",
              since: a.since,
              ...(a.position === undefined ? {} : { position: a.position }),
            }
          : { task: check.task, kind: "check", label: a.step ?? "checks", since: a.since },
      );
    }
    return { checks, background };
  }

  private async one(id: string, now: number): Promise<HomeCheck | undefined> {
    const kept = this.kept.get(id);
    if (kept !== undefined && now - kept.at < REUSE_MS) return kept.row;
    const revision = this.revision;
    const state = await this.deps.state(id).catch(() => undefined);
    if (state === undefined) return undefined;
    const checks = await this.deps.mergeChecks(id).catch(() => undefined);
    if (checks === undefined) return undefined;
    const empty = (await this.deps.empty?.(id).catch(() => false)) === true;
    const outcome = firstSentence(this.deps.lastMessage(id));
    const verdict = checks.verdict;
    const stepId =
      verdict.kind === "failed" ? (verdict.check === "test" ? "tests" : verdict.check) : undefined;
    const step =
      stepId === undefined || stepId === "secret"
        ? undefined
        : state.current?.steps.find((s) => s.id === stepId);
    const row: HomeCheck = {
      task: id,
      checks,
      ...(empty ? { empty: true as const } : {}),
      ...(outcome === undefined ? {} : { outcome }),
      ...(state.activity === undefined ? {} : { activity: state.activity }),
      ...(step === undefined
        ? {}
        : {
            failedStep: {
              id: step.id,
              status: step.status,
              ...(step.ms === undefined ? {} : { ms: step.ms }),
            },
          }),
    };
    if (this.revision === revision) this.kept.set(id, { at: now, row });
    return row;
  }
}

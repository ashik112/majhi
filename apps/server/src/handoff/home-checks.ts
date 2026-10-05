import type { HandoffState, HomeBackground, HomeCheck, MergeChecks } from "@majhi/shared";

export interface HomeChecksDeps {
  /** Tasks in review: the ones whose rows show a check. */
  ids(): string[];
  /** The merge gate's verdict for the task's head now. */
  mergeChecks(id: string): Promise<MergeChecks>;
  state(id: string): Promise<HandoffState>;
  /** The agent's last message in the task, whole. */
  lastMessage(id: string): string | undefined;
  now?: () => number;
}

/** A verdict reads git (the diff scan): reuse it this long while the hand-off state has not changed. */
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
  private readonly kept = new Map<string, { key: string; at: number; checks: MergeChecks }>();

  constructor(private readonly deps: HomeChecksDeps) {}

  async facts(): Promise<{ checks: HomeCheck[]; background: HomeBackground[] }> {
    const now = this.deps.now?.() ?? Date.now();
    const ids = this.deps.ids();
    for (const id of this.kept.keys()) if (!ids.includes(id)) this.kept.delete(id);
    const rows = await Promise.all(ids.map((id) => this.one(id, now)));
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
    const state = await this.deps.state(id).catch(() => undefined);
    if (state === undefined) return undefined;
    const key = [state.running, state.queued, state.stale, state.current?.at, state.current?.head].join("|");
    const kept = this.kept.get(id);
    const outcome = firstSentence(this.deps.lastMessage(id));
    let checks: MergeChecks;
    if (kept !== undefined && kept.key === key && now - kept.at < REUSE_MS) {
      checks = kept.checks;
    } else {
      const fresh = await this.deps.mergeChecks(id).catch(() => undefined);
      if (fresh === undefined) return undefined;
      checks = fresh;
      this.kept.set(id, { key, at: now, checks });
    }
    const verdict = checks.verdict;
    const stepId =
      verdict.kind === "failed" ? (verdict.check === "test" ? "tests" : verdict.check) : undefined;
    const step =
      stepId === undefined || stepId === "secret"
        ? undefined
        : state.current?.steps.find((s) => s.id === stepId);
    return {
      task: id,
      checks,
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
  }
}

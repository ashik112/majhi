import {
  type DecisionLabel,
  DecisionLabelSchema,
  type DecisionUseSchema,
  type LabelSource,
  type LinkKind,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import type { z } from "zod";
import { redactText } from "../admin/policy.ts";

type Use = z.infer<typeof DecisionUseSchema>;

interface LabelRow {
  decision_id: string;
  use: string;
  question: string;
  label: string;
  source: string;
  note: string | null;
  at: string;
}

/**
 * Outcome labels (`decision_labels`): the right answer to one question of one decision. One label
 * per decision, question and source, so the owner's answer and an outcome can disagree and both are
 * kept. Links (`decision_links`) hold a decision until its outcome is known.
 */
export class LabelStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The decision's use, or undefined when it is not in the log. */
  useOf(decisionId: string): Use | undefined {
    const row = this.db.prepare("SELECT use FROM decisions WHERE id = ?").get(decisionId) as
      | { use: string }
      | undefined;
    const parsed = DecisionLabelSchema.shape.use.safeParse(row?.use);
    return parsed.success ? parsed.data : undefined;
  }

  /** Writes or replaces a label. False when the decision is not in the log. */
  add(input: {
    decisionId: string;
    question: string;
    label: string;
    source: LabelSource;
    note?: string | undefined;
  }): boolean {
    const use = this.useOf(input.decisionId);
    if (use === undefined) return false;
    this.db
      .prepare(
        `INSERT INTO decision_labels (decision_id, use, question, label, source, note, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (decision_id, question, source) DO UPDATE SET label = excluded.label, note = excluded.note, at = excluded.at`,
      )
      .run(
        input.decisionId,
        use,
        input.question,
        input.label.trim(),
        input.source,
        input.note === undefined ? null : redactText(input.note),
        this.now().toISOString(),
      );
    return true;
  }

  forDecision(decisionId: string): DecisionLabel[] {
    return this.parse(
      this.db
        .prepare("SELECT * FROM decision_labels WHERE decision_id = ? ORDER BY at")
        .all(decisionId) as LabelRow[],
    );
  }

  /** Every label of a use, oldest first. */
  forUse(use: Use): DecisionLabel[] {
    return this.parse(
      this.db
        .prepare("SELECT * FROM decision_labels WHERE use = ? ORDER BY at, rowid")
        .all(use) as LabelRow[],
    );
  }

  counts(): { use: string; question: string; n: number }[] {
    return this.db
      .prepare("SELECT use, question, COUNT(*) AS n FROM decision_labels GROUP BY use, question")
      .all() as { use: string; question: string; n: number }[];
  }

  /** Waits for the outcome of `ref`. Linking again is harmless. */
  link(kind: LinkKind, ref: string, decisionId: string, question: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO decision_links (kind, ref, decision_id, question, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(kind, ref, decisionId, question, this.now().toISOString());
  }

  links(kind: LinkKind, ref: string): { decisionId: string; question: string }[] {
    return (
      this.db
        .prepare("SELECT decision_id, question FROM decision_links WHERE kind = ? AND ref = ?")
        .all(kind, ref) as {
        decision_id: string;
        question: string;
      }[]
    ).map((r) => ({ decisionId: r.decision_id, question: r.question }));
  }

  /**
   * The outcome of `ref` is known: labels every decision linked to it. `consume` removes the links
   * (a fact kept once stays kept); without it they stay for a later, better outcome (a task that
   * reaches review again). Resolves how many labels were written.
   */
  resolve(
    kind: LinkKind,
    ref: string,
    outcome: {
      label: string | ((question: string, use: Use) => string | undefined);
      note?: string | undefined;
    },
    consume = false,
  ): number {
    let written = 0;
    for (const link of this.links(kind, ref)) {
      const use = this.useOf(link.decisionId);
      if (use === undefined) continue;
      const label = typeof outcome.label === "string" ? outcome.label : outcome.label(link.question, use);
      if (label === undefined) continue;
      if (
        this.add({
          decisionId: link.decisionId,
          question: link.question,
          label,
          source: "outcome",
          note: outcome.note,
        })
      )
        written += 1;
    }
    if (consume) this.db.prepare("DELETE FROM decision_links WHERE kind = ? AND ref = ?").run(kind, ref);
    return written;
  }

  private parse(rows: LabelRow[]): DecisionLabel[] {
    return rows.flatMap((r) => {
      const parsed = DecisionLabelSchema.safeParse({
        decisionId: r.decision_id,
        use: r.use,
        question: r.question,
        label: r.label,
        source: r.source,
        ...(r.note === null ? {} : { note: r.note }),
        at: r.at,
      });
      return parsed.success ? [parsed.data] : [];
    });
  }
}

// Free labelers: the pure part -----------------------------------------------

export interface TaskOutcome {
  /** Files in the finished diff, over all repos. */
  files: number;
  /** Lines added plus lines removed. */
  lines: number;
  /** Agent turns spent on the task. */
  turns: number;
  /** Output plus reasoning tokens spent on the task. */
  outputTokens: number;
}

const LEVELS = ["trivial", "small", "medium", "large"] as const;

function bucket(value: number, bounds: readonly [number, number, number]): number {
  const at = bounds.findIndex((b) => value <= b);
  return at === -1 ? 3 : at;
}

/**
 * How big a task turned out to be, with fixed thresholds: the larger of what the diff says (files
 * and lines changed) and what the work took (turns and output tokens). A small diff after a long hunt
 * is still a large task: that is what "a hard bug hunt" means in the question's options.
 */
export function sizeBucket(o: TaskOutcome): { label: (typeof LEVELS)[number]; note: string } {
  const byDiff = Math.max(bucket(o.lines, [10, 60, 400]), bucket(o.files, [1, 3, 12]));
  const byWork = Math.max(bucket(o.turns, [4, 15, 40]), bucket(o.outputTokens, [8_000, 40_000, 200_000]));
  const level = Math.max(byDiff, byWork);
  return {
    label: LEVELS[level] ?? "large",
    note: `${o.files} files and ${o.lines} lines changed, ${o.turns} turns, ${Math.round(o.outputTokens / 1000)}k output tokens`,
  };
}

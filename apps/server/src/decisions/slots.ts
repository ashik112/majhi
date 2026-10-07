import type { DecideRequestInput, DecisionLabel, DecisionRecord } from "@majhi/shared";

type Use = DecisionRecord["use"];

/** One labeled example that ships with majhi: a request, the question to read and the right answer. */
export interface Fixture {
  request: DecideRequestInput;
  question: string;
  label: string;
}

/**
 * A slot is one question of one use: the unit that is labeled, evaluated, calibrated and run live or
 * in shadow. Adding a use to the decision provider is adding a slot here, as data. Nothing else
 * in the eval harness or the gate knows any slot by name.
 */
export interface SlotDef {
  id: string;
  /** Plain words, as the Hub shows it. */
  title: string;
  use: Use;
  /** The question keys this slot covers (a mention asks one per agent, so a pattern). */
  question: RegExp;
  /** The precision an answer must reach before it acts, on held-out labels. */
  target: number;
  /**
   * `shadow` (the default): the slot acts on nothing until an eval passes. `live`: the base bar acts
   * until then. Only for a use that was checked by hand before, and where shadow would remove a
   * protection.
   */
  startMode?: "shadow" | "live";
  /**
   * For a slot that starts live: the sureness (0 to 1, from the model's own probabilities) an answer
   * needs before it acts, until the slot is calibrated and moves to its measured bar. Below it the
   * answer defers to the caller's safe default. Default: no bar beyond the base one.
   */
  startBar?: number;
  /** A bigger model may label this slot's answers, a few a day (the stand-in agent, never an outside one). */
  teacher?: boolean;
  /** The class an answer counts as when comparing it with a label. Default: the answer itself. */
  classOf?: (value: string) => string;
  /** Built-in labeled examples. Report only: they never move a slot to live. */
  fixtures?: () => Fixture[];
}

/** Labels a slot needs before majhi tries to fit it. */
export const MIN_LABELS = 50;

/** New labels a slot collects before it is fitted again. */
export const REFIT_EVERY = 10;

/** Answers a day (per use) the stand-in agent may give as a teacher. */
export const TEACHER_PER_DAY = 12;

/** The uses whose answers an agent or the owner reads themselves: never in shadow, nothing acts on them. */
export const READ_BY_HAND: ReadonlySet<Use> = new Set<Use>(["tool", "owner"]);

export class SlotRegistry {
  private readonly slots: SlotDef[] = [];

  constructor(defs: readonly SlotDef[] = []) {
    for (const d of defs) this.add(d);
  }

  add(def: SlotDef): void {
    if (this.slots.some((s) => s.id === def.id)) throw new Error(`Slot ${def.id} is already defined`);
    this.slots.push(def);
  }

  all(): readonly SlotDef[] {
    return this.slots;
  }

  byId(id: string): SlotDef | undefined {
    return this.slots.find((s) => s.id === id);
  }

  /** The slot a question belongs to. A question no slot names gets its own, `use/question`, in shadow. */
  of(use: Use, question: string): SlotDef {
    return (
      this.slots.find((s) => s.use === use && s.question.test(question)) ?? {
        id: `${use}/${question}`,
        title: `${use} ${question}`,
        use,
        question: new RegExp(`^${question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        target: 0.9,
      }
    );
  }

  /** Whether a label belongs to the slot. */
  has(def: SlotDef, label: Pick<DecisionLabel, "use" | "question">): boolean {
    return def.use === label.use && def.question.test(label.question);
  }
}

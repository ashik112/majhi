import type { CaptainUndo, CommandName, TaskPriority } from "@majhi/shared";

/**
 * What the upkeep chores read and do in majhi (SPEC 5.18). The real ports are built from majhi's own
 * services in `world.ts`; the soak test plays them. Every port takes the workspace it acts in, and
 * returns only that workspace's things.
 */

/** A task in review, as the ship chore sees it. */
export interface ReviewTask {
  id: string;
  title: string;
  /** The task's head commits, one per repo: a ship-ready card is posted once per state of the work. */
  heads: string;
}

/** Why a task in review is not ready to ship, or what it would ship and the checks that passed. */
export type ShipCheck =
  | { ready: false; why: string }
  | {
      ready: true;
      /** The checks that passed, one line. */
      evidence: string;
      /** Each changed repo and the branch it ships to. */
      targets: { project: string; into: string; base: string }[];
    };

/** A pending approval card an agent posted. */
export interface ApprovalCard {
  task: string;
  item: string;
  agent: string;
  command: CommandName;
  input: Record<string, unknown>;
  summary: string;
}

/** A pending question of an agent: an ask, a choice, a permission prompt or a question in plain text. */
export interface QuestionCard {
  task: string;
  item: string;
  agent: string;
  kind: "ask" | "choice" | "permission" | "owner-question";
  /** The question, one line. */
  text: string;
  /** The options to pick from: an option id and its words. Empty for an ask card with free text. */
  options: { id: string; label: string }[];
  /** For an ask card: the question's id. */
  question?: string | undefined;
}

export interface PendingFact {
  id: number;
  text: string;
}

export interface NewRepo {
  path: string;
  name: string;
  /** The project id it would get. */
  id: string;
  base: string;
  remotes: { name: string; url: string }[];
  /** Why the captain is not sure where it belongs, so it asks instead. */
  unsure?: string | undefined;
}

export interface TriageTask {
  id: string;
  title: string;
  status: string;
  priority?: TaskPriority | undefined;
  due?: string | undefined;
  updatedAt: string;
}

export interface CaptainPorts {
  // Ship finished work
  reviewTasks(org: string): Promise<ReviewTask[]>;
  shipCheck(org: string, task: string): Promise<ShipCheck>;
  /** Merges (and pushes when `push`) by the workspace's ship rule. Returns what Undo needs. */
  ship(
    org: string,
    task: string,
    how: { push: boolean },
    reason: string,
  ): Promise<{ text: string; undo?: CaptainUndo | undefined; undoNote?: string | undefined }>;
  /** Puts the captain's line on the task's review card: ready to ship, the owner decides. */
  shipReady(org: string, task: string, line: string): Promise<void>;

  // Approval cards
  approvals(org: string): ApprovalCard[];
  /** Approves the card as the owner's approval rules allow, or leaves it with the line why. */
  decideCard(
    org: string,
    card: ApprovalCard,
    verdict: { decision: "approved" | "left"; why: string },
  ): Promise<{ ok: boolean; error?: string | undefined; commit?: string | undefined }>;
  /** The table that decides a card, with the workspace's level. */
  cardVerdict(
    org: string,
    card: ApprovalCard,
    level: "tidy" | "runs",
  ): Promise<{ decision: "approved" | "left"; why: string }>;

  // Agents' questions
  questions(org: string): QuestionCard[];
  /** Laya through the decision provider: an option id when it is sure, else undefined with why. */
  laya(org: string, card: QuestionCard): Promise<{ option?: string | undefined; why: string }>;
  answer(org: string, card: QuestionCard, option: string, reason: string): Promise<void>;
  /** A short turn of the captain in the workspace's lane. False with why when the lane rests. */
  askLane(org: string, text: string): Promise<{ sent: true } | { sent: false; why: string }>;

  // Memory
  pendingFacts(org: string): Promise<PendingFact[]>;
  curate(
    org: string,
    fact: PendingFact,
  ): Promise<{ outcome: "kept" | "dropped" | "merged" | "pending"; event?: number | undefined }>;

  // Projects
  newRepos(org: string): Promise<NewRepo[]>;
  register(org: string, repo: NewRepo, reason: string): Promise<{ commit?: string | undefined }>;

  // Task triage
  triageTasks(org: string): TriageTask[];
  setPriority(org: string, task: string, priority: TaskPriority, reason: string): Promise<void>;

  // Cleanup
  cleanable(org: string): Promise<{ id: string; title: string; steps: string[] }[]>;
  clean(org: string, task: string): Promise<{ removed: string[]; kept: string[] }>;

  // Stuck tasks
  /** Running tasks where nobody works and nothing is pending, with when the last turn ended. */
  stalled(org: string): { id: string; lead: string; quietSince: string }[];
  wakeLead(org: string, task: string): void;
  pauseForOwner(org: string, task: string, text: string): Promise<void>;

  // Always
  /** When the owner last acted in the task. */
  ownerAt(task: string): string | undefined;
}

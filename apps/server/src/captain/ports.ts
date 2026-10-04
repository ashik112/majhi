import type { Authority, CaptainUndo, CommandName, TaskPriority } from "@majhi/shared";
import type { FollowUpPorts } from "../findings/followups.ts";
import type { FindingsService } from "../findings/service.ts";
import type { OwnWorkScope } from "./own-work.ts";
import type { SecondOpinion } from "./own-work-second.ts";

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
  | {
      ready: false;
      why: string;
      /** Only the owner can clear it (a card waits, a protected repo): a lead is not told. */
      owner?: boolean;
      /** It conflicts with its base. Who resolves that follows the workspace's Merge row. */
      conflict?: boolean;
    }
  | {
      ready: true;
      /** The checks that passed, one line. */
      evidence: string;
      /** What the checked hand-off ran, one line, for the log. The card shows it in its own block. */
      checked?: string;
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
  options: { id: string; label: string; effect?: "allow" | "deny" }[];
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
  /** Names for the task box, suggested from the repo's folder and package names. */
  aliases: string[];
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
  /** The table that decides a card, with the workspace's authority rows. */
  cardVerdict(
    org: string,
    card: ApprovalCard,
    authority: Authority,
  ): Promise<{ decision: "approved" | "left"; why: string }>;

  // Agents' questions
  questions(org: string): QuestionCard[];
  /**
   * Where Own work may approve in this task (SPEC 5.18), or undefined when the captain did not start
   * it, it is the owner's to keep, or it has no worktree.
   */
  ownScope(org: string, task: string): Promise<OwnWorkScope | undefined>;
  /**
   * Laya's second opinion on a request the rule table could not place (SPEC 5.12). Absent or
   * `approve: false`: the request stays the owner's, as it always was.
   */
  ownSecondOpinion?(card: QuestionCard, scope: OwnWorkScope): Promise<SecondOpinion>;
  /**
   * An agent keeps asking the same thing: the line goes into the task's room for the owner, and the
   * agent gets one message telling it to stop asking.
   */
  flagLoop(org: string, card: QuestionCard, line: string, nudge: string): Promise<void>;
  answer(org: string, card: QuestionCard, option: string, reason: string): Promise<void>;
  /** Why the workspace's lane rests now (its budget, the day budget, its account), or undefined. */
  laneRest(org: string): Promise<string | undefined>;
  /** A short turn of the captain in the workspace's lane. False with why when the lane rests. */
  askLane(org: string, text: string): Promise<{ sent: true } | { sent: false; why: string }>;

  // Memory
  pendingFacts(org: string): Promise<PendingFact[]>;
  curate(
    org: string,
    fact: PendingFact,
  ): Promise<{
    outcome: "kept" | "dropped" | "merged" | "pending";
    event?: number | undefined;
    /** Why, in a short phrase: "a one-off symptom of one task". */
    reason?: string | undefined;
  }>;

  // Projects
  newRepos(org: string): Promise<NewRepo[]>;
  register(org: string, repo: NewRepo, reason: string): Promise<{ commit?: string | undefined }>;

  // Task triage
  triageTasks(org: string): TriageTask[];
  setPriority(org: string, task: string, priority: TaskPriority, reason: string): Promise<void>;

  // Cleanup
  cleanable(org: string): Promise<{ id: string; title: string; steps: string[] }[]>;
  clean(org: string, task: string): Promise<{ removed: string[]; kept: string[] }>;
  /** What deleting rebuildable folders of done tasks would free in the workspace (code only). */
  foldersFreeable?(org: string): Promise<{ bytes: number; tasks: number }>;
  /** Deletes them. Never tracked files, never a task with uncommitted changes or one reopened. */
  freeFolders?(
    org: string,
  ): Promise<{ bytes: number; tasks: { id: string; bytes: number; worktrees: number; folders: number }[] }>;

  // Stuck tasks
  /** Running tasks where nobody works and nothing is pending, with when the last turn ended. */
  stalled(org: string): { id: string; lead: string; quietSince: string }[];
  /**
   * Tasks held up by an account that needs a new sign-in: the lead cannot run (the task runs quiet,
   * or paused as signed-out), or a teammate's step failed on its sign-in and nobody works.
   */
  signInStalls(org: string): Promise<SignInStall[]>;
  /** Gives the lead's place to `to`, a teammate whose account works, and starts the task again. */
  moveLead(org: string, task: string, to: string, reason: string): Promise<void>;
  /** Wakes the lead to give the step of `agent`, whose account needs a sign-in, to a teammate. */
  handBack(org: string, task: string, agent: string, account: string): void;
  wakeLead(org: string, task: string): void;
  pauseForOwner(org: string, task: string, text: string): Promise<void>;

  // Follow-ups and findings
  followUps: FollowUpPorts;
  findings: FindingsService;

  // Always
  /** Whether the owner is typing in the task now: the captain waits (SPEC 5.18, Presence). */
  typing(task: string): boolean;
}

/** A task an account that needs a new sign-in holds up. */
export interface SignInStall {
  id: string;
  lead: string;
  /** The agent that cannot run: the lead, or the teammate whose step failed. */
  agent: string;
  account: string;
  /** The first teammate, in team order, whose account works. Undefined when none does. */
  to?: string | undefined;
  /** When the account was found signed out, so a later sign-out is a new matter. */
  since: string;
}

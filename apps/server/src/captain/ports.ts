import type { Authority, CaptainUndo, CommandName, DeployRecord, ShipFix, TaskPriority } from "@majhi/shared";
import type { FollowUpPorts } from "../findings/followups.ts";
import type { FindingsService } from "../findings/service.ts";
import type { ShipPlan } from "../ship/plan.ts";
import type { AnswerResult } from "./keys.ts";
import type { OwnWorkScope } from "./own-work.ts";
import type { UpkeepPorts, WikiPorts } from "./upkeep-ports.ts";

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
  /** The tip of the branch each repo goes onto, one per repo. A ship is keyed by the heads and these. */
  bases?: string | undefined;
}

/** A task in review with no code change: its lead's last message is the answer. */
export interface AnswerTask {
  id: string;
  title: string;
  /** An investigation or an answer. A code task that changed nothing is not one: it is left for the owner. */
  investigation: boolean;
  lead?: string | undefined;
  /** The lead's last message, its final report. Absent when it never wrote one. */
  report?: { text: string; at: string } | undefined;
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
      /**
       * Merge would fail now: `empty` when nothing is ahead of the base, `failing` for a conflict,
       * uncommitted work, a secret in the diff or a merge git refuses. The owner's card says so
       * instead of offering Merge.
       */
      unmergeable?: "empty" | "failing";
      /** Work left uncommitted in a repo: the lead is asked to commit or discard it. */
      uncommitted?: { project: string; files: string[] };
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
  /** Steps the brief lists (`- [ ]` items), when there are any. */
  checklist?: number | undefined;
}

/** A deploy step of merged work that is next: the captain does it, or it waits for the owner. */
export interface DeployNext {
  task: string;
  title: string;
  project: string;
  env: string;
  /** The planned record that starts it. */
  record: number;
  commit: string;
  /** Who does it by the ship rules. */
  who: "captain" | "owner";
  /** What the rule that decided covers, in words ("A bug up to 200 lines"). Absent when the rows decided. */
  rule?: string | undefined;
}

/** A ready task that changes projects with deploy environments and has no deploy plan yet. */
export interface DeployPlanNeed {
  task: string;
  title: string;
  /** The projects the task changes that have environments, with each one's environments in words. */
  projects: { project: string; environments: string[] }[];
}

/** Deploying merged work: what the ship chore reads and does after a merge. The real port is the deploy service. */
export interface DeployPorts {
  /** Whether a ready task needs its deploy planned: it changes a project with environments and has no plan rows. */
  needsPlan(org: string, task: string): Promise<DeployPlanNeed | undefined>;
  /** The deploy steps of work merged lately in the workspace that are next, by the ship rules, guards read now. */
  next(org: string): Promise<DeployNext[]>;
  /** Why the step may not go now, read again right before it, or undefined. */
  recheck(org: string, step: DeployNext): Promise<string | undefined>;
  /** Starts it as the captain. Answers at once; the run is followed in the background. */
  deploy(org: string, step: DeployNext): Promise<{ record: DeployRecord; repeat: boolean }>;
}

export interface CaptainPorts {
  // Ship finished work
  reviewTasks(org: string): Promise<ReviewTask[]>;
  /** Tasks whose merge requests are open: the captain's merge of them waits on the deploy plan, so it is asked for. */
  mrTasks?(org: string): Promise<ReviewTask[]>;
  /**
   * Who does each step of shipping the task, and how it lands: the workspace's rows refined by its ship
   * rules, for the task as it is now. The lane's calls and the lead's cards read the same one.
   */
  shipPlan(org: string, task: string): Promise<ShipPlan>;
  /** `except`: the item id of a pending card that does not count as waiting (the lead's merge card). */
  shipCheck(org: string, task: string, except?: string): Promise<ShipCheck>;
  /** Merges (and pushes when `push`) by the workspace's ship rule. Returns what Undo needs. */
  ship(
    org: string,
    task: string,
    how: { push: boolean },
    reason: string,
  ): Promise<{ text: string; undo?: CaptainUndo | undefined; undoNote?: string | undefined }>;
  /** Asks the task's lead to bring main in, resolve the conflicts and merge (tasks.resolveShip), as the captain. */
  resolveShip(org: string, task: string, reason: string): Promise<void>;
  /** Puts the captain's line on the task's review card: ready to ship, the owner decides. */
  shipReady(org: string, task: string, line: string): Promise<void>;
  /** Puts "the captain tried to ship it and failed" on the task's review card. */
  shipFailed(org: string, task: string, error: string): Promise<void>;
  /**
   * Whether a task that passed the ship checks can go to its host as a merge request, and where.
   * Not ok: no remote or no MR token, with the one line why.
   */
  mrReady(
    org: string,
    task: string,
  ): Promise<{ ok: true; host: string } | { ok: false; why: string; fix?: ShipFix | undefined }>;
  /** Pushes the task's branches and opens one merge request per repo (tasks.openMrs), as the captain. Never merges. */
  openMrs(
    org: string,
    task: string,
    reason: string,
  ): Promise<{ urls: string[]; host: string; failed?: string | undefined }>;
  /** Tasks in review that changed no repo (an answer or a report), with no card waiting and no agent working. */
  answerTasks(org: string): Promise<AnswerTask[]>;
  /** Marks an answer task done (tasks.close), as the captain. */
  closeAnswer(org: string, task: string, reason: string): Promise<void>;
  /** Sends the lead a line and puts the task back to work, as the owner's Ask for changes does. */
  askChanges(org: string, task: string, text: string): Promise<void>;
  /** Settles a lead's merge card as answered by an opened merge request, and tells the lead (the owner merges on the host). */
  settleMergeCard(org: string, card: ApprovalCard, line: string): Promise<void>;

  // Approval cards
  approvals(org: string): ApprovalCard[];
  /** Approves the card as the owner's approval rules allow, or leaves it with the line why. */
  decideCard(
    org: string,
    card: ApprovalCard,
    verdict: {
      decision: "approved" | "left";
      why: string;
      risky?: boolean | undefined;
      fix?: ShipFix | undefined;
    },
  ): Promise<{
    ok: boolean;
    error?: string | undefined;
    commit?: string | undefined;
    /** The card was answered before (or is being answered): nothing ran now. */
    repeat?: true | undefined;
  }>;
  /** The table that decides a card, with the workspace's authority rows. */
  cardVerdict(
    org: string,
    card: ApprovalCard,
    authority: Authority,
  ): Promise<{ decision: "approved" | "left"; why: string; risky?: boolean | undefined }>;

  // Agents' questions
  questions(org: string): QuestionCard[];
  /**
   * Where Own work may approve in this task (SPEC 5.18), or undefined when the captain did not start
   * it, it is the owner's to keep, or it has no worktree.
   */
  ownScope(org: string, task: string): Promise<OwnWorkScope | undefined>;
  /** One answer per card: a second answer to the same card changes nothing and says so. */
  answer(org: string, card: QuestionCard, option: string, reason: string): Promise<AnswerResult>;
  /** Why the workspace's lane rests now (its budget, the day budget, its account), or undefined. */
  laneRest(org: string): Promise<string | undefined>;
  /** A short turn of the captain in the workspace's lane. False with why when the lane rests. */
  askLane(org: string, text: string): Promise<{ sent: true } | { sent: false; why: string }>;

  // Memory
  pendingFacts(org: string): Promise<PendingFact[]>;
  curate(
    org: string,
    fact: PendingFact,
    /** Outcome rules the owner switched off (`mem-keep`, `mem-drop`, `mem-escalate`). */
    off?: ReadonlySet<string> | undefined,
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
  /** Done tasks with something to remove, and the worktrees of them that hold uncommitted changes (never removed). */
  cleanable(org: string): Promise<{ id: string; title: string; steps: string[]; dirty: string[] }[]>;
  clean(org: string, task: string): Promise<{ removed: string[]; kept: string[] }>;
  /**
   * With `dry`, lists what would be freed. Otherwise frees the ignored dependency caches of tasks done for longer than `cleanup.caches_after_days`
   * (source, branches and room history stay). Never a reopened task or a worktree with uncommitted changes.
   */
  freeCaches?(org: string, dry: boolean): Promise<{ id: string; removed: string[] }[]>;
  /** What deleting rebuildable folders of done tasks would free in the workspace (code only). */
  foldersFreeable?(org: string): Promise<{ bytes: number; tasks: number }>;
  /** Deletes them. Never tracked files, never a task with uncommitted changes or one reopened. */
  freeFolders?(
    org: string,
  ): Promise<{ bytes: number; tasks: { id: string; bytes: number; worktrees: number; folders: number }[] }>;

  // Follow-ups and findings
  followUps: FollowUpPorts;
  findings: FindingsService;

  /** The self-upkeep chores: discover, tidy, health and the checklist. Absent: they do nothing. */
  upkeep?: UpkeepPorts;

  /** Deploying merged work. Absent: the ship chore deploys nothing. */
  deploys?: DeployPorts;

  /** The project wiki: whether it is on and behind, and the one update. Absent: the wiki chore does nothing. */
  wiki?: WikiPorts;

  // Always
  /** Whether the owner is typing in the task now: the captain waits (SPEC 5.18, Presence). */
  typing(task: string): boolean;
}

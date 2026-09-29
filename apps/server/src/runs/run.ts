import type { AgentSession, PermissionAsk } from "@majhi/acp";
import type { AgentLive, AuthMode, Perm, Task, ToolId } from "@majhi/shared";
import type { Usage } from "./context.ts";
import type { ItemMapper } from "./items.ts";

/** What the drive loop sends next. */
export type QueueEntry =
  /** The task's first prompt, built from TASK.md. */
  | { kind: "brief" }
  /** An owner message stored in the room. */
  | { kind: "owner"; itemId: string }
  /** Continue a turn that was cut (restart, crash, offline, wake). */
  | { kind: "resume" }
  /** Continue after a recovery compaction, in the same turn. */
  | { kind: "continue" }
  /** The owner asked for a fresh session. */
  | { kind: "fresh" };

/** What a fresh session gets before its first prompt (SPEC 5.13). */
export interface Carry {
  taskMd: string;
  note: string;
  room: string[];
  diffStat: string;
}

export interface Pending {
  ask: PermissionAsk;
  resolve: (option: string | undefined) => void;
}

export type PauseReason = "offline" | "error";

/** Everything the manager holds for one (task, agent). */
export class AgentRun {
  live: AgentLive;
  session: AgentSession | undefined;
  runId: number | undefined;
  mapper: ItemMapper | undefined;
  queue: QueueEntry[] = [];
  /** The queue waits: the owner pressed Esc, or stopped the task. A new message releases it. */
  held = false;
  /** Stop was called: the drive loop leaves quietly. */
  closing = false;
  exited = false;
  turning = false;
  cancelBeforePrompt = false;
  needsBrief = false;
  /** Stop reason of the last finished turn. */
  lastStop: string | undefined;
  /** The majhi-admin token of this session, revoked when it ends. */
  adminToken: string | undefined;
  /** The majhi-decide token of this session, revoked when it ends. */
  decideToken: string | undefined;
  /** The admin preamble goes in front of the session's first prompt. */
  preambleDue = false;
  drive: Promise<void> | undefined;
  /** Start the loop again when the current one ends (a resume arrived while it was finishing). */
  redrive = false;
  readonly pending = new Map<string, Pending>();
  perms: Perm[] = [];
  permSeq = 0;
  unsubscribe: (() => void) | undefined;

  /** The agent's account, for the per-account limit. Known once a session was started. */
  account: string | undefined;
  /** The account's tool and auth, for the turn rows (Phase 2c). Known once a session was started. */
  accountKind: { tool: ToolId; auth: AuthMode } | undefined;
  /** The agent's own `context.compact_at`, read at session start. */
  compactAt: number | undefined;
  /** Turns in the current session. */
  turns = 0;
  /** The last usage the agent reported in this session. */
  usage: Usage | undefined;
  /** Increases with every usage report, so a compaction can wait for the next one. */
  usageSeq = 0;
  private usageWaiters: (() => void)[] = [];
  /** Compactions while handling the current prompt (at most 2). */
  compactions = 0;
  /** Given to the next prompt of a fresh session. */
  carry: Carry | undefined;
  /** The next session must be new: the old one was handed off. */
  freshNext = false;
  /** Set while majhi talks to the agent itself (compact, handoff note): its reply is collected, not shown. */
  internal: { text: string } | undefined;
  /** The current or last turn was cut and must continue. */
  interrupted = false;
  /** Paused runs send nothing until resumed. */
  paused: PauseReason | undefined;
  /** A resume is under way; failures count toward the limit of two. */
  resuming = false;
  resumeFailures = 0;
  /** The last failure may pass by itself (network, timeout), so a wake retries it. */
  retryable = false;
  /** When the agent last reported anything. */
  lastEventAt = 0;
  idleTimer: NodeJS.Timeout | undefined;
  retryTimer: NodeJS.Timeout | undefined;
  /** The owner asked for a fresh session while a turn ran. */
  freshDue = false;
  /** The room already said this run waits for a slot. */
  queuedNoted = false;

  constructor(
    readonly task: Task["id"],
    readonly agent: string,
    queued: number,
  ) {
    this.live = { agent, status: "stopped", queued, commands: [] };
  }

  noteUsage(usage: Usage): void {
    this.usage = usage;
    this.usageSeq++;
    const waiters = this.usageWaiters;
    this.usageWaiters = [];
    for (const w of waiters) w();
  }

  /** Resolves when a usage report newer than `seq` arrives, or after `ms`. */
  waitUsage(seq: number, ms: number): Promise<void> {
    if (this.usageSeq > seq) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      function done() {
        resolve();
      }
      this.usageWaiters.push(waiter);
    });
  }

  clearTimers(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.idleTimer = undefined;
    this.retryTimer = undefined;
  }
}

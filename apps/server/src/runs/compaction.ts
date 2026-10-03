import type { RoomItem, Task } from "@majhi/shared";
import { UserError } from "../errors.ts";
import {
  budgetFor,
  COMPACT_NOTE,
  type ContextBudget,
  compactCommand,
  estimateText,
  MAX_COMPACTIONS_PER_TURN,
  reachedTarget,
} from "./context.ts";
import { buildCarry, type DurableDeps } from "./durable.ts";
import { freshPrompt, HANDOFF_REQUEST, looksLikeNote } from "./handoff.ts";
import type { RunLive } from "./live.ts";
import type { NativeCompaction } from "./native.ts";
import type { AgentRun, Carry, PauseReason } from "./run.ts";

/** How long native compaction waits for the agent's next usage report. */
const USAGE_WAIT_MS = 5_000;

/** How long an agent cut by a turn limit has to write its handoff note before majhi builds one. */
const NOTE_WAIT_MS = 5 * 60_000;

export type CompactReason = "threshold" | "rotation" | "fresh" | "recovery";

/** What compaction needs from the run manager: ending a session, and pausing a run. */
export interface CompactionHost {
  /** Ends the session; `keepSlot` hands its slot to the fresh session that follows. */
  endSession(run: AgentRun, reason: string, keepSlot: boolean): void;
  pause(run: AgentRun, reason: PauseReason, text: string): void;
}

/**
 * Keeps each session inside its context budget (SPEC 5.13): native `/compact` first, then a
 * handoff note from the agent, then one majhi builds from saved state. A handoff closes the
 * session at once; the next prompt opens a fresh one carrying the note.
 */
export class Compaction {
  constructor(
    private readonly deps: DurableDeps,
    private readonly live: RunLive,
    private readonly host: CompactionHost,
  ) {}

  /** The run's budget now: majhi's settings, then the org's `compact_at` and `cap`, then the agent's. */
  async budget(run: AgentRun): Promise<ContextBudget> {
    const { config, store } = this.deps;
    const [settings, sections] = await Promise.all([config.settings(), config.sections()]);
    const org = store.tasks.get(run.task)?.org;
    const budget = budgetFor(
      settings.context,
      org === undefined ? undefined : sections.orgs[org]?.context,
      run.context,
    );
    run.budget = budget;
    return budget;
  }

  /**
   * Brings the session back under its budget and returns the room's context line, or undefined
   * when the run paused instead (the per-turn cap). Fresh sessions do not count toward the cap.
   */
  async compact(run: AgentRun, why: CompactReason, budget: ContextBudget): Promise<RoomItem | undefined> {
    if (why !== "fresh" && run.compactions >= MAX_COMPACTIONS_PER_TURN) {
      this.host.pause(
        run,
        "error",
        `@${run.agent} is still over its context budget after ${MAX_COMPACTIONS_PER_TURN} compactions in one turn, so it paused. Use Fresh session, then resume the task.`,
      );
      return undefined;
    }
    run.selfCompacting = true;
    try {
      return await this.compactNow(run, why, budget);
    } finally {
      run.selfCompacting = false;
      run.native.reset();
    }
  }

  /**
   * The CLI compacted on its own inside a turn (PRV-103). Recorded and shown like majhi's own, but
   * it does not count toward `MAX_COMPACTIONS_PER_TURN`: that cap is for majhi's compactions.
   */
  auto(run: AgentRun, found: NativeCompaction): RoomItem {
    return this.contextEvent(run, { method: "auto", before: found.before, after: found.after });
  }

  private async compactNow(run: AgentRun, why: CompactReason, budget: ContextBudget): Promise<RoomItem> {
    if (why !== "fresh") run.compactions++;
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) throw new UserError(`Task ${run.task} does not exist.`, 404);
    const before = run.usage?.used;
    this.live.set(run, { nowDoing: "Compacting its context" });

    if (why === "threshold") {
      const command = compactCommand(run.live.commands);
      if (command !== undefined && run.session !== undefined) {
        const seq = run.usageSeq;
        const res = await this.internalPrompt(run, `${command} ${COMPACT_NOTE}`);
        if (res.ok) await run.waitUsage(seq, USAGE_WAIT_MS);
        if (res.ok && run.usageSeq > seq && reachedTarget(run.usage, budget)) {
          this.live.set(run, { nowDoing: undefined });
          return this.contextEvent(run, { method: "native", before, after: run.usage?.used });
        }
      }
    }

    // Hand off. The agent writes the note unless its session is past saving.
    const built = await this.handOff(
      run,
      task,
      why !== "recovery",
      why === "recovery" ? "the session hit its limit" : "the agent did not write a note",
    );
    return this.contextEvent(run, {
      method: why === "threshold" ? "handoff" : why,
      before,
      after: estimateText(freshPrompt(built.carry)),
      note: built.path,
    });
  }

  /**
   * A turn limit cut the turn (PRV-96): hand off to a fresh session. The agent writes the note,
   * within `NOTE_WAIT_MS`, unless it went idle (`askAgent` false): then majhi builds it at once.
   * The room gets no context line; the caller posts the one line the owner sees.
   */
  async afterTurnLimit(run: AgentRun, askAgent: boolean, why: string): Promise<void> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) throw new UserError(`Task ${run.task} does not exist.`, 404);
    const before = run.usage?.used;
    const built = await this.handOff(run, task, askAgent, why, NOTE_WAIT_MS);
    this.deps.store.usageEvents.recordCompaction({
      task: run.task,
      agent: run.agent,
      at: new Date().toISOString(),
      method: "handoff",
      before,
      after: estimateText(freshPrompt(built.carry)),
    });
  }

  /** Asks for the note (or builds it), closes the session and sets the carry for the next one. */
  private async handOff(
    run: AgentRun,
    task: Task,
    askAgent: boolean,
    why: string,
    noteWaitMs?: number,
  ): Promise<{ path: string; carry: Carry }> {
    let note: string | undefined;
    if (askAgent && run.session !== undefined && !run.exited) {
      this.live.set(run, { nowDoing: "Writing a handoff note for its fresh session" });
      const res = await this.internalPrompt(run, HANDOFF_REQUEST, noteWaitMs);
      if (res.ok && looksLikeNote(res.text)) note = res.text.trim();
    }
    const built = await buildCarry(this.deps, task, run.agent, note, why);
    const session = run.session;
    if (session !== undefined) {
      this.host.endSession(run, "handoff", true);
      void session.close().catch(() => undefined);
    }
    run.freshNext = true;
    run.carry = built.carry;
    run.turns = 0;
    run.usage = undefined;
    run.native.reset();
    this.live.set(run, { usage: undefined, turns: 0, nowDoing: undefined });
    return built;
  }

  /**
   * The window is full (a stop reason or an error says so): hand off with majhi's own note and
   * queue "continue". False when the run paused instead.
   */
  async recover(run: AgentRun, why: string): Promise<boolean> {
    this.live.system(run, "warn", `@${run.agent} ran out of room (${why}). Moving it to a fresh session.`);
    if ((await this.compact(run, "recovery", await this.budget(run))) === undefined) return false;
    run.queue.unshift({ kind: "continue" });
    return true;
  }

  /** The owner's "Fresh session". Without a live session the note is built from saved state. */
  async fresh(run: AgentRun): Promise<RoomItem> {
    const { store } = this.deps;
    const task = store.tasks.get(run.task);
    if (task === undefined) throw new UserError(`Task ${run.task} does not exist.`, 404);
    if (run.session !== undefined) {
      const item = await this.compact(run, "fresh", await this.budget(run));
      if (item !== undefined) return item;
    }
    if (!store.runs.ranBefore(run.task, run.agent)) {
      return this.live.systemItem(
        run,
        "info",
        `@${run.agent} has no session yet. Its first message starts one.`,
      );
    }
    const built = await buildCarry(
      this.deps,
      task,
      run.agent,
      undefined,
      "the owner asked for a fresh session",
    );
    run.carry = built.carry;
    run.freshNext = true;
    return this.contextEvent(run, {
      method: "fresh",
      after: estimateText(freshPrompt(built.carry)),
      note: built.path,
    });
  }

  /** A new session for an agent that worked here before: its work comes over in a note majhi builds. */
  async carryOver(run: AgentRun): Promise<void> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) return;
    const built = await buildCarry(
      this.deps,
      task,
      run.agent,
      undefined,
      "the previous session could not be loaded",
    );
    run.carry = built.carry;
    this.contextEvent(run, {
      method: "recovery",
      note: built.path,
      after: estimateText(freshPrompt(built.carry)),
    });
  }

  /** The room's context line, and the same event kept for the task's token receipt. */
  private contextEvent(run: AgentRun, event: Parameters<RunLive["context"]>[1]): RoomItem {
    this.deps.store.usageEvents.recordCompaction({
      task: run.task,
      agent: run.agent,
      at: new Date().toISOString(),
      method: event.method,
      before: event.before,
      after: event.after,
    });
    return this.live.context(run, event);
  }

  /**
   * Sends majhi's own prompt (compact, handoff request). The reply is collected, not shown in the
   * room. With `timeoutMs`, a reply that takes longer is cancelled and counts as none.
   */
  private async internalPrompt(
    run: AgentRun,
    text: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; text: string }> {
    const session = run.session;
    if (session === undefined) return { ok: false, text: "" };
    const internal = { text: "" };
    run.internal = internal;
    let timer: NodeJS.Timeout | undefined;
    try {
      const reply = session.prompt([{ type: "text", text }]);
      const res =
        timeoutMs === undefined
          ? await reply
          : await Promise.race([
              reply,
              new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), timeoutMs);
                timer.unref();
              }),
            ]);
      if (res === undefined) {
        await session.cancel().catch(() => undefined);
        // The cancelled prompt settles on its own; nothing waits for it.
        void reply.catch(() => undefined);
        return { ok: false, text: internal.text };
      }
      return { ok: res.stopReason === "end_turn", text: internal.text };
    } catch {
      return { ok: false, text: internal.text };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      run.internal = undefined;
    }
  }
}

import { randomUUID } from "node:crypto";
import type { AgentLive, RoomItem } from "@majhi/shared";
import type { RoomService } from "../room/service.ts";
import type { RoomPayload } from "../store/index.ts";
import type { AgentRun } from "./run.ts";

/** A change to an agent's live state. `undefined` clears a field. */
export type LivePatch = { [K in keyof Omit<AgentLive, "agent">]?: AgentLive[K] | undefined };

/** Busy with the task, including waiting in line for a slot: never "your turn". */
export const WORKING: ReadonlySet<AgentLive["status"]> = new Set([
  "queued",
  "starting",
  "working",
  "waiting",
]);

export type ContextMethod = Extract<RoomItem, { type: "context" }>["method"];

/**
 * What every part of the run manager says: an agent's live state, and its lines in the room.
 * One place, so live state is sent only when it changed and the task list hears when an agent
 * starts or stops working.
 */
export class RunLive {
  constructor(
    private readonly room: RoomService,
    private readonly onTasksChanged: () => void,
  ) {}

  set(run: AgentRun, patch: LivePatch): void {
    const wasWorking = WORKING.has(run.live.status);
    const merged: Record<string, unknown> = { ...run.live, ...patch };
    for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
    // Every key comes from AgentLive or a LivePatch of it, so the merge is an AgentLive.
    const next = merged as unknown as AgentLive;
    if (JSON.stringify(next) === JSON.stringify(run.live)) return;
    run.live = next;
    this.room.setLive(run.task, next);
    if (wasWorking !== WORKING.has(next.status)) this.onTasksChanged();
  }

  /** The owner's messages waiting for the agent's next turn. majhi's own entries do not count. */
  refreshQueued(run: AgentRun): void {
    const queued = run.queue.filter((e) => e.kind === "owner" || e.kind === "brief").length;
    if (run.live.queued !== queued) this.set(run, { queued });
  }

  post(run: AgentRun, payload: RoomPayload, options?: { defer?: boolean }): string {
    const id = `${run.agent}:${run.runId ?? "x"}:${randomUUID()}`;
    this.room.post(run.task, id, payload, options);
    return id;
  }

  system(run: AgentRun, level: "info" | "warn" | "error", text: string): void {
    this.post(run, { type: "system", level, text, agent: run.agent });
  }

  /** A system line, returned as the stored item (for commands that answer with it). */
  systemItem(run: AgentRun, level: "info" | "warn" | "error", text: string): RoomItem {
    const id = this.post(run, { type: "system", level, text, agent: run.agent });
    const item = this.room.get(run.task, id);
    if (item === undefined) throw new Error("The item was not stored");
    return item;
  }

  /** One compaction, as the room's quiet context line. Returns the stored item. */
  context(
    run: AgentRun,
    event: {
      method: ContextMethod;
      before?: number | undefined;
      after?: number | undefined;
      note?: string | undefined;
    },
  ): RoomItem {
    const id = `context:${randomUUID()}`;
    this.room.post(run.task, id, {
      type: "context",
      agent: run.agent,
      method: event.method,
      ...(event.before === undefined ? {} : { before: event.before }),
      ...(event.after === undefined ? {} : { after: event.after }),
      ...(event.note === undefined ? {} : { note: event.note }),
    });
    const item = this.room.get(run.task, id);
    if (item === undefined) throw new Error("The item was not stored");
    return item;
  }
}

import type { PermissionAsk } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import { permissionPayload } from "./items.ts";
import type { RunLive } from "./live.ts";
import { decidePermission } from "./permissions.ts";
import type { AgentRun } from "./run.ts";

/**
 * Permission requests from agents (SPEC 5.15): allowed by the agent's perms or an earlier "Allow
 * for this task", else a prompt in the room that waits for the owner. Every decision is logged.
 */
export class PermissionFlow {
  constructor(
    private readonly deps: { store: Store; room: RoomService },
    private readonly live: RunLive,
    private readonly now: () => Date,
  ) {}

  /** The session's permission handler. Resolves with the option id, or undefined when cancelled. */
  ask(run: AgentRun, ask: PermissionAsk, signal: AbortSignal): Promise<string | undefined> {
    const { store, room } = this.deps;
    const decision = decidePermission(ask, {
      perms: run.perms,
      rememberedFor: (k) => store.permissions.allowed(run.task, k),
    });
    const id = `perm:${run.runId ?? "x"}:${++run.permSeq}`;
    const base = {
      type: "permission" as const,
      agent: run.agent,
      title: ask.title,
      ...(ask.toolCallId === undefined ? {} : { toolCallId: ask.toolCallId }),
      options: ask.options,
    };
    if (decision.action === "allow") {
      room.post(run.task, id, { ...base, state: "auto", chosen: decision.option });
      this.log(run, ask, "allow", "rule");
      return Promise.resolve(decision.option);
    }
    room.post(run.task, id, { ...base, state: "pending" });
    this.live.set(run, { status: "waiting" });
    return new Promise<string | undefined>((resolve) => {
      run.pending.set(id, { ask, resolve });
      signal.addEventListener("abort", () => this.cancelOne(run, id), { once: true });
    });
  }

  /** The owner picked one of the prompt's options. */
  answer(run: AgentRun | undefined, task: string, itemId: string, option: string): RoomItem {
    const { store, room } = this.deps;
    const pending = run?.pending.get(itemId);
    const item = room.get(task, itemId);
    if (run === undefined || pending === undefined || item === undefined || item.type !== "permission") {
      throw new UserError("That prompt is not waiting for an answer any more.", 409);
    }
    const chosen = pending.ask.options.find((o) => o.id === option);
    if (chosen === undefined) {
      throw new UserError(
        `"${option}" is not one of the options: ${pending.ask.options.map((o) => o.id).join(", ")}.`,
      );
    }
    run.pending.delete(itemId);
    const allowed = chosen.kind === "allow_once" || chosen.kind === "allow_always";
    this.log(run, pending.ask, allowed ? "allow" : "deny", "owner");
    if (chosen.kind === "allow_always") store.permissions.allow(task, pending.ask.kind ?? "other");
    room.post(item.task, itemId, permissionPayload(item, { state: "answered", chosen: option }));
    pending.resolve(option);
    this.backToWork(run);
    const updated = room.get(task, itemId);
    if (updated === undefined) throw new Error("The prompt was not stored");
    return updated;
  }

  /** Withdraws every prompt of the run that still waits. */
  cancelAll(run: AgentRun): void {
    for (const id of [...run.pending.keys()]) this.cancelOne(run, id);
  }

  /** Marks one pending prompt cancelled and releases the agent's wait. */
  private cancelOne(run: AgentRun, id: string): void {
    const pending = run.pending.get(id);
    if (pending === undefined) return;
    run.pending.delete(id);
    const item = this.deps.room.get(run.task, id);
    if (item !== undefined && item.type === "permission") {
      this.deps.room.post(item.task, id, permissionPayload(item, { state: "cancelled" }));
    }
    this.log(run, pending.ask, "cancelled", "owner");
    pending.resolve(undefined);
    this.backToWork(run);
  }

  private backToWork(run: AgentRun): void {
    if (run.pending.size === 0 && run.live.status === "waiting") this.live.set(run, { status: "working" });
  }

  private log(
    run: AgentRun,
    ask: PermissionAsk,
    decision: "allow" | "deny" | "cancelled",
    by: "owner" | "rule",
  ): void {
    this.deps.store.permissions.log({
      task: run.task,
      agent: run.agent,
      kind: ask.kind ?? "other",
      title: ask.title,
      decision,
      by,
      at: this.now().toISOString(),
    });
  }
}

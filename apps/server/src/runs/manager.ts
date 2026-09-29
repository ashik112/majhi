import { randomUUID } from "node:crypto";
import type { AgentSession, PermissionAsk, PromptBlock, RuntimeOptions, SessionEvent } from "@majhi/acp";
import type { AgentLive, Attachment, Perm, RoomItem, Task } from "@majhi/shared";
import { accountRuntime, secretName } from "../accounts/homes.ts";
import type { AdminAccess } from "../admin/access.ts";
import { ADMIN_PREAMBLE, isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { RoomPayload, Store } from "../store/index.ts";
import { ItemMapper, ownerPayload, permissionPayload } from "./items.ts";
import { taskMediaSink } from "./media.ts";
import { decidePermission } from "./permissions.ts";
import { briefBlocks, ownerBlocks } from "./prompt.ts";

export const BRIEF_ITEM_ID = "brief";

export interface RunDeps {
  store: Store;
  room: RoomService;
  runtime: AcpRuntime;
  options: RuntimeOptions;
  agents: AgentStore;
  config: ConfigService;
  secrets: SecretStore;
  majhiHome: string;
  /** Gives sessions of the boss (and other admin agents) the majhi-admin MCP server. */
  admin?: AdminAccess;
  /** Called when the set of working agents of some task changed, so the task list can refresh. */
  onTasksChanged: () => void;
  /** Called when an agent finished a turn normally and has nothing queued: the task may be ready for review. */
  onIdle?: (task: string) => void;
  now?: () => Date;
}

type QueueEntry = { kind: "brief" } | { kind: "owner"; itemId: string };

interface Pending {
  ask: PermissionAsk;
  resolve: (option: string | undefined) => void;
}

/** Everything the manager holds for one (task, agent). */
class AgentRun {
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
  /** The admin preamble goes in front of the session's first prompt. */
  preambleDue = false;
  drive: Promise<void> | undefined;
  readonly pending = new Map<string, Pending>();
  perms: Perm[] = [];
  permSeq = 0;
  unsubscribe: (() => void) | undefined;

  constructor(
    readonly task: Task["id"],
    readonly agent: string,
    queued: number,
  ) {
    this.live = { agent, status: "stopped", queued, commands: [] };
  }
}

/** A change to an agent's live state. `undefined` clears a field. */
type LivePatch = { [K in keyof Omit<AgentLive, "agent">]?: AgentLive[K] | undefined };

const WORKING: ReadonlySet<AgentLive["status"]> = new Set(["starting", "working", "waiting"]);

/**
 * One ACP session per (task, agent), started when there is something to send. Runs the queue
 * of prompts, turns session events into room items and live state, and answers permission
 * requests from the agent's perms or from the owner.
 */
export class RunManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly now: () => Date;

  constructor(private readonly deps: RunDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** At server start: runs that were live are over, and prompts nobody can answer any more are cancelled. */
  recover(): void {
    const { store, room } = this.deps;
    store.runs.endAllLive("server-restart", this.now().toISOString());
    for (const item of store.room.pendingPermissions()) {
      if (item.type === "permission")
        room.post(item.task, item.id, permissionPayload(item, { state: "cancelled" }));
    }
  }

  /** True when the agent is starting, working or waiting in any task. */
  isWorking(agent: string): boolean {
    return [...this.runs.values()].some((r) => r.agent === agent && WORKING.has(r.live.status));
  }

  /** Agents of the task that are starting, working or waiting. */
  working(task: string): string[] {
    return [...this.runs.values()]
      .filter((r) => r.task === task && WORKING.has(r.live.status))
      .map((r) => r.agent);
  }

  /**
   * Queues the task's first prompt, built from TASK.md, and starts the agent. Does nothing
   * when it was sent before. Returns at once: the run streams into the room.
   */
  startTask(task: Task, agent: string): void {
    const run = this.runFor(task.id, agent);
    const { room } = this.deps;
    // The boss chat has no brief to send: the owner's first message starts it.
    if (room.get(task.id, BRIEF_ITEM_ID) === undefined && !isBossChat(task)) {
      room.post(task.id, BRIEF_ITEM_ID, {
        type: "owner",
        text: task.brief,
        attachments: task.attachments,
        queued: false,
        to: agent,
      });
      run.queue.unshift({ kind: "brief" });
    }
    run.held = false;
    this.refreshQueued(run);
    void this.drive(run);
  }

  /** Stores the owner's message and sends it: now when the agent is idle, else queued, or after a cancel when `interrupt`. */
  async send(
    task: Task,
    agent: string,
    input: { text: string; attachments: Attachment[]; mode: "queue" | "interrupt" },
  ): Promise<RoomItem> {
    const run = this.runFor(task.id, agent);
    const busy = run.turning;
    const queued = busy && input.mode === "queue";
    const id = `owner:${randomUUID()}`;
    this.deps.room.post(task.id, id, {
      type: "owner",
      text: input.text,
      attachments: input.attachments,
      queued,
      to: agent,
    });
    const item = this.deps.room.get(task.id, id);
    if (item === undefined) throw new Error("The message was not stored");
    if (busy && input.mode === "interrupt") run.queue.unshift({ kind: "owner", itemId: id });
    else run.queue.push({ kind: "owner", itemId: id });
    run.held = false;
    this.refreshQueued(run);
    if (busy && input.mode === "interrupt") await this.cancelRun(run);
    void this.drive(run);
    return item;
  }

  /** Stops the current turn of one agent, or of every agent in the task. Queued messages wait. */
  async cancel(task: string, agent?: string): Promise<string[]> {
    const targets = [...this.runs.values()].filter(
      (r) => r.task === task && (agent === undefined || r.agent === agent) && r.turning,
    );
    for (const run of targets) if (run.queue.length > 0) run.held = true;
    await Promise.all(targets.map((run) => this.cancelRun(run)));
    return targets.map((r) => r.agent);
  }

  /** Cancels every turn and closes every session of the task. */
  async stop(task: string): Promise<void> {
    const targets = [...this.runs.values()].filter((r) => r.task === task);
    await Promise.all(
      targets.map(async (run) => {
        run.closing = true;
        run.held = true;
        this.cancelPending(run);
        const session = run.session;
        if (session !== undefined) {
          await session.cancel().catch(() => undefined);
          await session.close().catch(() => undefined);
        }
        await run.drive?.catch(() => undefined);
        // A session that opened while we were stopping.
        await run.session?.close().catch(() => undefined);
        this.endSession(run, "stopped");
        this.setLive(run, { status: "stopped", nowDoing: undefined });
        run.closing = false;
      }),
    );
  }

  /** Answers a pending permission prompt with one of its options. */
  answerPermission(task: string, itemId: string, option: string): RoomItem {
    const run = [...this.runs.values()].find((r) => r.task === task && r.pending.has(itemId));
    const pending = run?.pending.get(itemId);
    const item = this.deps.room.get(task, itemId);
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
    const kind = pending.ask.kind ?? "other";
    this.deps.store.permissions.log({
      task,
      agent: run.agent,
      kind,
      title: pending.ask.title,
      decision: allowed ? "allow" : "deny",
      by: "owner",
      at: this.now().toISOString(),
    });
    if (chosen.kind === "allow_always") this.deps.store.permissions.allow(task, kind);
    this.deps.room.post(item.task, itemId, permissionPayload(item, { state: "answered", chosen: option }));
    pending.resolve(option);
    if (run.pending.size === 0 && run.live.status === "waiting") this.setLive(run, { status: "working" });
    const updated = this.deps.room.get(task, itemId);
    if (updated === undefined) throw new Error("The prompt was not stored");
    return updated;
  }

  /** Resolves when no agent of the task (or of any task) is running a turn. For tests and shutdown. */
  async idle(task?: string): Promise<void> {
    for (;;) {
      const busy = [...this.runs.values()].filter(
        (r) => (task === undefined || r.task === task) && r.drive !== undefined,
      );
      if (busy.length === 0) return;
      await Promise.all(busy.map((r) => r.drive?.catch(() => undefined)));
    }
  }

  /** Forgets a removed task. Sessions must be stopped first. */
  forget(task: string): void {
    for (const [key, run] of this.runs) if (run.task === task) this.runs.delete(key);
    this.deps.room.drop(task);
  }

  /** Server shutdown: closes every session so no agent process outlives majhi. */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        run.closing = true;
        this.cancelPending(run);
        await run.session?.close().catch(() => undefined);
        this.endSession(run, "server-stop");
      }),
    );
  }

  // ---------------------------------------------------------------------------

  private key(task: string, agent: string): string {
    return `${task}\u0000${agent}`;
  }

  private runFor(task: Task["id"], agent: string): AgentRun {
    const key = this.key(task, agent);
    let run = this.runs.get(key);
    if (run === undefined) {
      const queued = this.deps.store.room.queuedFor(task, agent);
      run = new AgentRun(task, agent, queued.length);
      run.live.commands = this.deps.room.knownCommands(agent);
      run.queue = queued.map((item) => ({ kind: "owner", itemId: item.id }));
      run.held = run.queue.length > 0;
      this.runs.set(key, run);
    }
    return run;
  }

  private setLive(run: AgentRun, patch: LivePatch): void {
    const wasWorking = WORKING.has(run.live.status);
    const merged: Record<string, unknown> = { ...run.live, ...patch };
    for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
    // Every key comes from AgentLive or a LivePatch of it, so the merge is an AgentLive.
    const next = merged as unknown as AgentLive;
    if (JSON.stringify(next) === JSON.stringify(run.live)) return;
    run.live = next;
    this.deps.room.setLive(run.task, next);
    if (wasWorking !== WORKING.has(next.status)) this.deps.onTasksChanged();
  }

  private refreshQueued(run: AgentRun): void {
    if (run.live.queued !== run.queue.length) this.setLive(run, { queued: run.queue.length });
  }

  private post(run: AgentRun, payload: RoomPayload, options?: { defer?: boolean }): void {
    this.deps.room.post(run.task, `${run.agent}:${run.runId ?? "x"}:${randomUUID()}`, payload, options);
  }

  private system(run: AgentRun, level: "info" | "warn" | "error", text: string): void {
    this.post(run, { type: "system", level, text, agent: run.agent });
  }

  /** Runs queued prompts one after another. One loop per agent at a time. */
  private drive(run: AgentRun): Promise<void> {
    if (run.turning) return run.drive ?? Promise.resolve();
    run.turning = true;
    const loop = this.loop(run);
    // The loop clears `turning` itself, in the same step as its last check of the queue.
    if (run.turning) run.drive = loop;
    return loop;
  }

  private async loop(run: AgentRun): Promise<void> {
    try {
      await this.runQueue(run);
    } catch (err) {
      // A bug or a closed database must not become an unhandled rejection that ends the server.
      try {
        this.system(run, "error", `@${run.agent} stopped: ${errorMessage(err)}`);
      } catch {
        // Nowhere left to say it.
      }
      this.setLive(run, { status: "error", nowDoing: undefined });
    } finally {
      run.turning = false;
      run.drive = undefined;
    }
  }

  private async runQueue(run: AgentRun): Promise<void> {
    while (run.queue.length > 0 && !run.held && !run.closing) {
      if (run.session === undefined) {
        const started = await this.startSession(run);
        if (!started) return;
        if (run.cancelBeforePrompt) {
          run.cancelBeforePrompt = false;
          if (run.queue.length > 0) run.held = true;
          break;
        }
      }
      if (run.closing) break;
      const session = run.session;
      const entry = run.queue.shift();
      if (session === undefined || entry === undefined) break;
      this.refreshQueued(run);
      const blocks = await this.blocksFor(run, entry);
      if (blocks === undefined) continue;
      this.setLive(run, { status: "working", nowDoing: undefined });
      run.mapper?.beginTurn();
      let stopReason: string;
      try {
        stopReason = (await session.prompt(blocks)).stopReason;
      } catch (err) {
        this.deps.room.flush(run.task);
        if (run.closing || run.exited) return;
        this.system(run, "error", `@${run.agent} failed: ${errorMessage(err)}`);
        this.endSession(run, "error");
        void session.close().catch(() => undefined);
        this.setLive(run, { status: "error", nowDoing: undefined });
        return;
      }
      run.lastStop = stopReason;
      this.finishTurn(run, stopReason);
    }
    if (run.session !== undefined && !run.exited && !run.closing) {
      this.setLive(run, { status: "idle", nowDoing: undefined });
      // Only a turn the agent ended itself hands the task back; Esc and stops keep it with the owner.
      if (run.queue.length === 0 && !run.held && run.lastStop === "end_turn") this.deps.onIdle?.(run.task);
    }
  }

  private async blocksFor(run: AgentRun, entry: QueueEntry): Promise<PromptBlock[] | undefined> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) return undefined;
    if (entry.kind === "brief") {
      run.needsBrief = false;
      return this.withPreamble(
        run,
        await briefBlocks({ folder: task.folder, attachments: task.attachments }),
      );
    }
    const item = this.deps.room.get(run.task, entry.itemId);
    if (item === undefined || item.type !== "owner") return undefined;
    if (item.queued) this.deps.room.post(item.task, item.id, ownerPayload(item, { queued: false }));
    const built = await ownerBlocks({
      folder: task.folder,
      attachments: item.attachments,
      text: item.text,
      needsBrief: run.needsBrief,
    });
    if (built.briefSent) run.needsBrief = false;
    return this.withPreamble(run, built.blocks);
  }

  /** Puts the admin preamble before a session's first prompt. Slash commands stay whole and keep it waiting. */
  private withPreamble(run: AgentRun, blocks: PromptBlock[]): PromptBlock[] {
    const first = blocks[0];
    if (!run.preambleDue || (first?.type === "text" && first.text.startsWith("/"))) return blocks;
    run.preambleDue = false;
    return [{ type: "text", text: ADMIN_PREAMBLE }, ...blocks];
  }

  private finishTurn(run: AgentRun, stopReason: string): void {
    this.deps.room.flush(run.task);
    const cancelled = stopReason === "cancelled";
    run.mapper?.endTurn(cancelled);
    this.cancelPending(run);
    if (cancelled) this.system(run, "info", `Stopped @${run.agent}'s turn.`);
    else if (stopReason === "max_tokens")
      this.system(run, "warn", `@${run.agent} stopped: it reached its output limit.`);
    else if (stopReason === "max_turn_requests")
      this.system(run, "warn", `@${run.agent} stopped: it reached its turn limit.`);
    else if (stopReason === "refusal") this.system(run, "warn", `@${run.agent} declined to continue.`);
    this.setLive(run, { nowDoing: undefined });
  }

  /** Opens the ACP session. On failure posts an error, sets the agent to `error`, and returns false. */
  private async startSession(run: AgentRun): Promise<boolean> {
    const { deps } = this;
    this.setLive(run, { status: "starting", nowDoing: undefined });
    try {
      const stored = await deps.agents.get(run.agent);
      if (stored === undefined) throw new UserError(`Agent "${run.agent}" does not exist.`);
      if (!stored.ok) throw new UserError(`Agent "${run.agent}" is invalid: ${stored.errors.join("; ")}`);
      const fm = stored.agent.frontmatter;
      const { accounts, boss } = await deps.config.sections();
      const account = accounts[fm.account];
      if (account === undefined) throw new UserError(`Account "${fm.account}" is not in majhi.yaml.`);
      if (fm.scope !== "root" && account.org !== fm.scope && account.org !== "private") {
        throw new UserError(
          `@${fm.id} works in "${fm.scope}" and cannot use the account of "${account.org}".`,
        );
      }
      let apiKey: string | undefined;
      if (account.auth === "api-key" && account.key !== undefined) {
        apiKey = await deps.secrets.get(secretName(account.key));
        if (apiKey === undefined)
          throw new UserError(`The API key of ${fm.account} is missing. Add the account again.`);
      }
      const runtimeAccount = accountRuntime(deps.majhiHome, fm.account, account, apiKey);
      await deps.runtime.prepareHome(runtimeAccount);
      const task = deps.store.tasks.get(run.task);
      if (task === undefined) throw new UserError(`Task ${run.task} does not exist.`);

      const model = fm.model === "auto" ? undefined : fm.model;
      const effort = fm.effort === "auto" ? undefined : fm.effort;
      const resume = deps.store.runs.lastSessionId(run.task, run.agent);
      const admin = deps.admin?.attach({ task: run.task, agent: run.agent }, fm, boss);
      const session = await deps.runtime
        .startSession({
          account: runtimeAccount,
          options: deps.options,
          cwd: task.folder,
          ...(resume === undefined ? {} : { resume }),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          ...(admin === undefined ? {} : { mcpServers: [admin.server] }),
        })
        .catch((err: unknown) => {
          if (admin !== undefined) deps.admin?.revoke(admin.token);
          throw err;
        });

      // What the agent runs after the session applied the options: a refused model keeps the default.
      const shownModel = session.models.defaultModel ?? model;
      const shownEffort = session.models.defaultEffort ?? effort;
      run.session = session;
      run.exited = false;
      run.perms = fm.perms;
      run.needsBrief = resume === undefined || session.sessionId !== resume;
      run.adminToken = admin?.token;
      run.preambleDue = admin !== undefined && run.needsBrief;
      run.runId = deps.store.runs.start({
        task: run.task,
        agent: run.agent,
        sessionId: session.sessionId,
        model: shownModel,
        effort: shownEffort,
        at: this.now().toISOString(),
      });
      run.mapper = new ItemMapper(
        run.agent,
        run.runId,
        { post: (id, payload, options) => deps.room.post(run.task, id, payload, options) },
        taskMediaSink(run.task, task.folder),
      );
      // Attach before anything else: the session buffers early events, and a crash must not be missed.
      run.unsubscribe = session.onEvent((event) => this.onEvent(run, event));
      session.setPermissionHandler((ask, signal) => this.onPermission(run, ask, signal));

      this.system(
        run,
        "info",
        `@${run.agent} ${run.needsBrief ? "started" : "resumed"} on ${fm.account}, model ${shownModel ?? "default"}, effort ${shownEffort ?? "default"}`,
      );
      if (fm.model === "auto" || fm.effort === "auto") {
        this.system(
          run,
          "info",
          `@${run.agent} is set to auto for model or effort. This version uses the agent's own default.`,
        );
      }
      this.setLive(run, {
        status: "idle",
        ...(shownModel === undefined ? {} : { model: shownModel }),
        ...(shownEffort === undefined ? {} : { effort: shownEffort }),
      });
      return true;
    } catch (err) {
      this.system(run, "error", `@${run.agent} could not start: ${errorMessage(err)}`);
      this.setLive(run, { status: "error", nowDoing: undefined });
      return false;
    }
  }

  private onEvent(run: AgentRun, event: SessionEvent): void {
    switch (event.type) {
      case "text":
      case "thought":
      case "media":
      case "plan":
        run.mapper?.apply(event);
        break;
      case "tool":
        run.mapper?.apply(event);
        this.setLive(run, { nowDoing: run.mapper?.nowDoing() });
        break;
      case "usage":
        if (event.size > 0) this.setLive(run, { usage: { used: event.used, size: event.size } });
        break;
      case "commands":
        this.deps.room.rememberCommands(run.agent, event.commands);
        this.setLive(run, { commands: event.commands });
        break;
      case "config":
        this.setLive(run, {
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.effort === undefined ? {} : { effort: event.effort }),
        });
        break;
      case "notice":
        this.system(run, event.level, event.text);
        break;
      case "exit":
        if (run.closing) break;
        run.exited = true;
        this.deps.room.flush(run.task);
        this.system(
          run,
          "error",
          `@${run.agent} stopped unexpectedly: ${event.error ?? `exit code ${event.code ?? "unknown"}`}`,
        );
        this.endSession(run, "exit");
        this.setLive(run, { status: "error", nowDoing: undefined });
        break;
    }
    if (event.type === "plan") this.setLive(run, { nowDoing: run.mapper?.nowDoing() });
  }

  private async onPermission(
    run: AgentRun,
    ask: PermissionAsk,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const { store } = this.deps;
    const kind = ask.kind ?? "other";
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
      this.deps.room.post(run.task, id, { ...base, state: "auto", chosen: decision.option });
      store.permissions.log({
        task: run.task,
        agent: run.agent,
        kind,
        title: ask.title,
        decision: "allow",
        by: "rule",
        at: this.now().toISOString(),
      });
      return decision.option;
    }
    this.deps.room.post(run.task, id, { ...base, state: "pending" });
    this.setLive(run, { status: "waiting" });
    return new Promise<string | undefined>((resolve) => {
      run.pending.set(id, { ask, resolve });
      signal.addEventListener("abort", () => this.cancelOne(run, id), { once: true });
    });
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
    this.deps.store.permissions.log({
      task: run.task,
      agent: run.agent,
      kind: pending.ask.kind ?? "other",
      title: pending.ask.title,
      decision: "cancelled",
      by: "owner",
      at: this.now().toISOString(),
    });
    pending.resolve(undefined);
    if (run.pending.size === 0 && run.live.status === "waiting") this.setLive(run, { status: "working" });
  }

  private cancelPending(run: AgentRun): void {
    for (const id of [...run.pending.keys()]) this.cancelOne(run, id);
  }

  private async cancelRun(run: AgentRun): Promise<void> {
    this.cancelPending(run);
    const session = run.session;
    if (session === undefined) {
      // Still starting: the loop checks this before it sends anything.
      if (run.turning) run.cancelBeforePrompt = true;
      return;
    }
    try {
      await session.cancel();
    } catch (err) {
      this.system(run, "error", `@${run.agent} did not stop: ${errorMessage(err)}. Its session was closed.`);
      this.endSession(run, "error");
      void session.close().catch(() => undefined);
      this.setLive(run, { status: "error", nowDoing: undefined });
    }
  }

  /** Drops the session and ends the run row. The queue stays for the next start. */
  private endSession(run: AgentRun, reason: string): void {
    run.unsubscribe?.();
    run.unsubscribe = undefined;
    if (run.adminToken !== undefined) this.deps.admin?.revoke(run.adminToken);
    run.adminToken = undefined;
    this.cancelPending(run);
    if (run.runId !== undefined) this.deps.store.runs.end(run.runId, reason, this.now().toISOString());
    run.session = undefined;
    run.runId = undefined;
    run.mapper = undefined;
  }
}

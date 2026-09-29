import type { AgentSession, PermissionAsk, PromptBlock, SessionEvent } from "@majhi/acp";

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** What a scripted turn can do. */
export interface Turn {
  blocks: PromptBlock[];
  emit(event: SessionEvent): void;
  /** Asks the permission handler, like an agent about to run a tool. Undefined means it was cancelled. */
  ask(ask: PermissionAsk): Promise<string | undefined>;
  /** Resolves when the owner cancels the turn. */
  untilCancelled(): Promise<void>;
  /** The first text block of the prompt. */
  text: string;
}

export type Script = (turn: Turn) => Promise<StopReason | undefined>;

/** An agent session in memory. Tests set `script` to say what each turn does. */
export class FakeSession implements AgentSession {
  readonly pid = undefined;
  readonly models = { models: [], efforts: [], defaultModel: "fake-model", defaultEffort: "medium" };
  /** Every prompt received, in order. */
  readonly prompts: PromptBlock[][] = [];
  cancels = 0;
  closed = false;
  /** Default: says "ok" and ends the turn. */
  script: Script = async (turn) => {
    turn.emit({ type: "text", messageId: "m", text: "ok" });
    return "end_turn";
  };
  private listeners: ((e: SessionEvent) => void)[] = [];
  private handler: ((ask: PermissionAsk, signal: AbortSignal) => Promise<string | undefined>) | undefined;
  private turn: AbortController | undefined;
  private readonly asks = new Set<AbortController>();

  constructor(readonly sessionId: string) {}

  onEvent(listener: (e: SessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  setPermissionHandler(
    handler: (ask: PermissionAsk, signal: AbortSignal) => Promise<string | undefined>,
  ): void {
    this.handler = handler;
  }

  /** Sends an event as if the agent process reported it. */
  emit(event: SessionEvent): void {
    for (const l of this.listeners) l(event);
  }

  async prompt(blocks: PromptBlock[]): Promise<{ stopReason: StopReason }> {
    if (this.closed) throw new Error("Session is closed");
    this.prompts.push(blocks);
    const controller = new AbortController();
    this.turn = controller;
    const cancelled = new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const first = blocks.find((b) => b.type === "text");
    const stop = await this.script({
      blocks,
      text: first?.type === "text" ? first.text : "",
      emit: (e) => this.emit(e),
      ask: (ask) => this.ask(ask),
      untilCancelled: () => cancelled,
    });
    this.turn = undefined;
    return { stopReason: controller.signal.aborted ? "cancelled" : (stop ?? "end_turn") };
  }

  async cancel(): Promise<void> {
    if (this.turn === undefined) return;
    this.cancels++;
    for (const ask of this.asks) ask.abort();
    this.turn.abort();
    // Give the script a moment to see the abort and end the turn, like a real agent.
    await new Promise((r) => setTimeout(r, 0));
  }

  async setOption(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    // A closed session ends its turn, like a killed process.
    for (const ask of this.asks) ask.abort();
    this.turn?.abort();
  }

  private async ask(ask: PermissionAsk): Promise<string | undefined> {
    if (this.handler === undefined) return undefined;
    const controller = new AbortController();
    this.asks.add(controller);
    try {
      return await this.handler(ask, controller.signal);
    } finally {
      this.asks.delete(controller);
    }
  }
}

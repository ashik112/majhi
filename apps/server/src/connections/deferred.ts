/** One answered command's result, until the agent has read it. */
export interface DeferredResult {
  text: string;
  /**
   * Asked when the result is about to go out in a message of its own. False when the agent read it
   * with a tool call meanwhile. True again on a repeat, so a prompt that was put back is still sent.
   */
  claim(): boolean;
}

/** The most results kept for one agent: an agent that never reads them cannot grow this without end. */
const MAX_HELD = 20;

/**
 * Results of commands the owner answered for an agent (ssh through majhi-connections), kept until the
 * agent reads them. Two ways reach the agent and the first one wins: the next majhi-connections tool
 * call while its turn runs (`take`), and a message that wakes it or goes with its next turn (`claim`).
 */
export class DeferredResults {
  private readonly open = new Map<string, { result: DeferredResult; by?: "tool" | "message" }[]>();

  add(task: string, agent: string, text: string): DeferredResult {
    const key = `${task}\u0000${agent}`;
    const entry: { result: DeferredResult; by?: "tool" | "message" } = {
      result: {
        text,
        claim: () => {
          if (entry.by === "tool") return false;
          entry.by = "message";
          this.drop(key, entry);
          return true;
        },
      },
    };
    this.open.set(key, [...(this.open.get(key) ?? []), entry].slice(-MAX_HELD));
    return entry.result;
  }

  /** What the agent has not read yet, oldest first. Each text is handed out once, and no message repeats it. */
  take(task: string, agent: string): string[] {
    const key = `${task}\u0000${agent}`;
    const taken = (this.open.get(key) ?? []).filter((e) => e.by === undefined);
    for (const entry of taken) {
      entry.by = "tool";
      this.drop(key, entry);
    }
    return taken.map((e) => e.result.text);
  }

  private drop(key: string, entry: object): void {
    const rest = (this.open.get(key) ?? []).filter((e) => e !== entry);
    if (rest.length === 0) this.open.delete(key);
    else this.open.set(key, rest);
  }
}

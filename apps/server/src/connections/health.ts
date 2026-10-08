import {
  type CheckOutcome,
  type ConnectionFailure,
  type ConnectionHealth,
  type ConnectionTestResult,
  FAILURE_LINE,
  needsOwner,
  nextHealth,
} from "@majhi/shared";
import type { ConnectionHealthRepo } from "../store/connection-health.ts";

/** A background re-check runs this often. */
export const RECHECK_INTERVAL_MS = 4 * 60 * 60_000;
/** Pause between two connections of one pass, so a pass never bursts against one service. */
const PASS_GAP_MS = 750;

export interface HealthDeps {
  repo: Pick<ConnectionHealthRepo, "get" | "all" | "set" | "delete">;
  /** Every stored connection, for the re-check pass and the startup check. */
  list: () => Promise<{ id: string; org: string; name: string }[]>;
  /** Runs the real check of one connection. It reports to `observe` itself. */
  check: (id: string) => Promise<ConnectionTestResult>;
  /** A state changed: screens refetch. */
  changed: () => void;
  /** A check passed (also when it was connected already), or a connected one stopped being connected. */
  moved?: (id: string, connected: boolean) => void;
  /** The owner has to do something: a finding on the board. */
  attention?: (item: { org: string; key: string; title: string; detail: string }) => void;
  now?: () => Date;
  intervalMs?: number;
  /** Tests give none. */
  gap?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** What one test result means for the state machine: a pass with what it checked, or a typed failure. */
export function outcomeOfTest(test: ConnectionTestResult): CheckOutcome {
  if (test.ok) {
    return {
      ok: true,
      checked: test.checked ?? [],
      ...(test.account === undefined ? {} : { account: test.account }),
      ...(test.attention === undefined ? {} : { attention: test.attention }),
    };
  }
  // A check that failed without saying why is a check majhi does not understand, never a pass.
  const failure: ConnectionFailure = test.failure ?? { reason: "unexpected" };
  return { ok: false, failure };
}

/**
 * The one state of every connection (SPEC 5.14). Every check ends here: the connect flow, the
 * Check now button, the background pass and a refused token renewal. The state machine in
 * `nextHealth` is the only thing that moves a state, and it moves it from a typed result. This class
 * keeps the states, saves them, tells the screens and asks the owner when a connection that worked stops.
 */
export class ConnectionHealthService {
  private readonly states: Map<string, ConnectionHealth>;
  private readonly running = new Map<string, Promise<ConnectionTestResult>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private passing = false;

  constructor(private readonly deps: HealthDeps) {
    this.states = deps.repo.all();
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  get(id: string): ConnectionHealth | undefined {
    return this.states.get(id);
  }

  /** A connect or a reconnect begins. The state is `connecting` until a check ends it. */
  start(id: string): ConnectionHealth {
    return this.apply(id, { type: "start", at: this.now() });
  }

  /** A check ended. A pass makes it connected; a failure makes it failed or needs-attention. */
  result(id: string, outcome: CheckOutcome): ConnectionHealth {
    return this.apply(id, { type: "result", at: this.now(), outcome });
  }

  /** A failure known without a call: a refused renewal, a revoked grant. */
  failed(id: string, failure: ConnectionFailure): ConnectionHealth {
    return this.result(id, { ok: false, failure });
  }

  /** What a finished test says about the connection. */
  observe(id: string, test: ConnectionTestResult): ConnectionHealth {
    return this.result(id, outcomeOfTest(test));
  }

  remove(id: string): void {
    this.states.delete(id);
    this.deps.repo.delete(id);
    this.deps.changed();
  }

  /** Runs the check once at a time per connection. Everyone who asks while it runs gets that answer. */
  check(id: string): Promise<ConnectionTestResult> {
    const running = this.running.get(id);
    if (running !== undefined) return running;
    const flight = this.deps.check(id).finally(() => this.running.delete(id));
    this.running.set(id, flight);
    return flight;
  }

  private apply(id: string, event: Parameters<typeof nextHealth>[1]): ConnectionHealth {
    const prev = this.states.get(id);
    const next = nextHealth(prev, event);
    this.states.set(id, next);
    this.deps.repo.set(id, next, this.now());
    if (changed(prev, next)) this.deps.changed();
    if (next.state === "connected") this.deps.moved?.(id, true);
    else if (prev?.state === "connected") this.deps.moved?.(id, false);
    if (
      next.state === "needs-attention" &&
      prev?.state === "connected" &&
      needsOwner(next.reason) &&
      this.deps.attention !== undefined
    ) {
      void this.tell(id, next);
    }
    return next;
  }

  private async tell(
    id: string,
    next: Extract<ConnectionHealth, { state: "needs-attention" }>,
  ): Promise<void> {
    const info = (await this.deps.list().catch(() => [])).find((c) => c.id === id);
    if (info === undefined) return;
    this.deps.attention?.({
      org: info.org,
      key: `health:${id}:${next.reason}`,
      title: `${info.name} needs attention`,
      detail: `${FAILURE_LINE[next.reason]}. ${next.fix} Open Connections and pick ${info.name}.`,
    });
  }

  /** Connections majhi never checked (from before this state existed): one check each, from the result. */
  async checkMissing(): Promise<void> {
    for (const c of await this.deps.list()) {
      if (this.states.has(c.id)) continue;
      await this.check(c.id).catch(() => undefined);
      await this.gap();
    }
  }

  /** One pass over every connection that is not in the middle of connecting. */
  async checkAll(): Promise<void> {
    if (this.passing) return;
    this.passing = true;
    try {
      for (const c of await this.deps.list()) {
        if (this.states.get(c.id)?.state === "connecting") continue;
        await this.check(c.id).catch((err: unknown) =>
          this.deps.log?.(
            `connections: re-check of ${c.id} did not run: ${err instanceof Error ? err.name : "error"}`,
          ),
        );
        await this.gap();
      }
    } finally {
      this.passing = false;
    }
  }

  private gap(): Promise<void> {
    return (this.deps.gap ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(PASS_GAP_MS);
  }

  /** Checks what was never checked now, then every few hours. */
  startSchedule(): void {
    void this.checkMissing().catch(() => undefined);
    this.timer = setInterval(
      () => void this.checkAll().catch(() => undefined),
      this.deps.intervalMs ?? RECHECK_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** True when the screens would show something different. */
function changed(prev: ConnectionHealth | undefined, next: ConnectionHealth): boolean {
  if (prev === undefined || prev.state !== next.state) return true;
  if (prev.state === "connected" && next.state === "connected") return prev.account !== next.account;
  if (prev.state === "connecting") return false;
  if (next.state === "failed" || next.state === "needs-attention") {
    const p = prev as typeof next;
    return p.reason !== next.reason || p.fix !== next.fix;
  }
  return false;
}

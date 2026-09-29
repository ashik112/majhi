import type { LimitsSettings } from "@majhi/shared";

/**
 * Concurrency limits on agent processes (SPEC 5.17): `agents_max` across majhi, `per_account`
 * and `per_task`. A process holds a slot from start until it stops. Starts that do not fit wait
 * in request order.
 *
 * Idle processes (waiting for the owner, not in a turn) hold slots too, but they can resume
 * later from their session, so a waiting start may stop the least recently used idle one that
 * is in its way instead of waiting for its idle timeout.
 */

export type Limits = Pick<LimitsSettings, "agents_max" | "per_account" | "per_task">;

export interface SlotRequest {
  /** One per (task, agent). */
  key: string;
  task: string;
  account: string;
}

export interface Holder extends SlotRequest {
  /** In a turn. Busy holders are never stopped to make room. */
  busy: boolean;
  /** When it last started or ended a turn, for picking the idle one to stop. */
  lastUsed: number;
}

type Limit = "global" | "account" | "task";

function over(req: SlotRequest, holders: readonly Holder[], limits: Limits): Limit[] {
  const out: Limit[] = [];
  if (holders.length >= limits.agents_max) out.push("global");
  if (holders.filter((h) => h.account === req.account).length >= limits.per_account) out.push("account");
  if (holders.filter((h) => h.task === req.task).length >= limits.per_task) out.push("task");
  return out;
}

/**
 * Which idle holders to stop so `req` fits, least recently used first, or undefined when
 * stopping idle ones is not enough.
 */
function evictionsFor(req: SlotRequest, holders: readonly Holder[], limits: Limits): string[] | undefined {
  let left = [...holders];
  const evicted: string[] = [];
  const idle = holders.filter((h) => !h.busy).sort((a, b) => a.lastUsed - b.lastUsed);
  for (;;) {
    const blocking = over(req, left, limits);
    if (blocking.length === 0) return evicted;
    // An idle holder that counts toward every limit in the way.
    const victim = idle.find(
      (h) =>
        !evicted.includes(h.key) &&
        blocking.every(
          (l) => l === "global" || (l === "account" ? h.account === req.account : h.task === req.task),
        ),
    );
    if (victim === undefined) return undefined;
    evicted.push(victim.key);
    left = left.filter((h) => h.key !== victim.key);
  }
}

export interface Plan {
  /** Keys that start now, in request order. */
  grant: string[];
  /** Idle holders to stop first. */
  evict: string[];
}

/**
 * Decides which waiting starts go now. Order is kept: a start never passes an earlier one that
 * waits for the same account, the same task, or a global slot.
 */
export function planGrants(
  waiting: readonly SlotRequest[],
  holders: readonly Holder[],
  limits: Limits,
): Plan {
  let current = [...holders];
  const plan: Plan = { grant: [], evict: [] };
  let globalBlocked = false;
  const accounts = new Set<string>();
  const tasks = new Set<string>();
  for (const req of waiting) {
    if (globalBlocked || accounts.has(req.account) || tasks.has(req.task)) {
      accounts.add(req.account);
      tasks.add(req.task);
      continue;
    }
    const blocking = over(req, current, limits);
    const evict = blocking.length === 0 ? [] : evictionsFor(req, current, limits);
    if (evict === undefined) {
      if (blocking.includes("global")) globalBlocked = true;
      accounts.add(req.account);
      tasks.add(req.task);
      continue;
    }
    plan.evict.push(...evict);
    current = current.filter((h) => !evict.includes(h.key));
    current.push({ ...req, busy: true, lastUsed: 0 });
    plan.grant.push(req.key);
  }
  return plan;
}

interface Waiter {
  req: SlotRequest;
  resolve: (granted: boolean) => void;
}

export interface SlotDeps {
  /** The limits now. Read each time, so changes apply live. */
  limits: () => Promise<Limits>;
  /** Stops an idle holder's process. Its slot is already free when this is called. */
  evict: (key: string) => void;
  /** The line changed: each waiting key and its 1-based place. */
  onQueue: (positions: Map<string, number>) => void;
  now?: () => number;
}

/** The slots in use and the line of starts waiting for one. */
export class Slots {
  private readonly holders = new Map<string, Holder>();
  private waiting: Waiter[] = [];
  private pumping: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: SlotDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Resolves true once the start may go, or false when it was withdrawn. At once when it fits. */
  acquire(req: SlotRequest): Promise<boolean> {
    if (this.holders.has(req.key)) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.waiting.push({ req, resolve });
      void this.pump();
    });
  }

  /** Frees the key's slot, or takes it out of the line. */
  release(key: string): void {
    const inLine = this.waiting.find((w) => w.req.key === key);
    if (inLine !== undefined) {
      this.waiting = this.waiting.filter((w) => w !== inLine);
      inLine.resolve(false);
    }
    if (this.holders.delete(key) || inLine !== undefined) void this.pump();
  }

  /** A holder started (busy) or ended (idle) a turn. */
  mark(key: string, busy: boolean): void {
    const holder = this.holders.get(key);
    if (holder === undefined) return;
    holder.busy = busy;
    holder.lastUsed = this.now();
    // An idle holder may be what a waiting start needs.
    if (!busy && this.waiting.length > 0) void this.pump();
  }

  holds(key: string): boolean {
    return this.holders.has(key);
  }

  /** 1-based place in line, or undefined when not waiting. */
  position(key: string): number | undefined {
    const i = this.waiting.findIndex((w) => w.req.key === key);
    return i === -1 ? undefined : i + 1;
  }

  /** Looks at the line again, for example after the limits changed. */
  pump(): Promise<void> {
    this.pumping = this.pumping.then(() => this.pumpOnce()).catch(() => undefined);
    return this.pumping;
  }

  private async pumpOnce(): Promise<void> {
    if (this.waiting.length === 0) return;
    const limits = await this.deps.limits();
    const plan = planGrants(
      this.waiting.map((w) => w.req),
      [...this.holders.values()],
      limits,
    );
    for (const key of plan.evict) {
      this.holders.delete(key);
      this.deps.evict(key);
    }
    for (const key of plan.grant) {
      const waiter = this.waiting.find((w) => w.req.key === key);
      if (waiter === undefined) continue;
      this.waiting = this.waiting.filter((w) => w !== waiter);
      this.holders.set(key, { ...waiter.req, busy: true, lastUsed: this.now() });
      waiter.resolve(true);
    }
    this.deps.onQueue(new Map(this.waiting.map((w, i) => [w.req.key, i + 1])));
  }
}

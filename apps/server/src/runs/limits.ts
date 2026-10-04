import type { LimitsSettings, SlotCapacity, SlotRoom } from "@majhi/shared";

/**
 * Concurrency limits on agent processes (SPEC 5.17): `agents_max` across majhi, `per_account`
 * and `per_task`. A process holds a slot from start until it stops. Starts that do not fit wait
 * in request order.
 *
 * Idle processes (waiting for the owner, not in a turn) hold slots too, but they can resume
 * later from their session, so a waiting start may stop the least recently used idle one that
 * is in its way instead of waiting for its idle timeout.
 */

export type Limits = Pick<LimitsSettings, "agents_max" | "per_account" | "per_task"> & {
  /** Machine-wide cap on runs, already resolved (see `runsTotal`). Absent: only `agents_max` applies. */
  runs_total?: number;
};

/** The default machine-wide run cap: a third of the cores, at least 2; 3 when the cores are not known. */
export function defaultRunsTotal(cores: number | undefined): number {
  return cores === undefined ? 3 : Math.max(2, Math.floor(cores / 3));
}

/** The cap on runs at once: the owner's `runs_total` or the default, and never above `agents_max`. */
export function runsTotal(limits: LimitsSettings, cores: number | undefined): number {
  return Math.min(limits.agents_max, limits.runs_total ?? defaultRunsTotal(cores));
}

/** The runs that may be in use at once on the machine. */
export function globalCap(limits: Pick<Limits, "agents_max" | "runs_total">): number {
  return Math.min(limits.agents_max, limits.runs_total ?? limits.agents_max);
}

export interface SlotRequest {
  /** One per (task, agent). */
  key: string;
  task: string;
  account: string;
  /** The workspace (org) the task belongs to. Fair slots split `agents_max` across these. */
  workspace?: string;
  /** The owner's own run (not started by the captain or autonomy). It goes first and is never preempted. */
  owner?: boolean;
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
  if (holders.length >= globalCap(limits)) out.push("global");
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

/** Who got a slot last, as an increasing number: the oldest turn goes first among equals. */
export interface Turns {
  workspace: Map<string, number>;
  /** Keyed by `account` and workspace, see `turnKey`. */
  account: Map<string, number>;
}

export function turnKey(account: string, workspace: string): string {
  return `${account}\u0000${workspace}`;
}

/**
 * The order in which waiting starts are looked at (SPEC 5.18, workspaces never collide). The
 * owner's own runs come first, in request order. With `fair` (Autonomous On) the rest are picked one
 * at a time from the workspace furthest below its share of the slots (fewest holders, counting the
 * ones picked already), so `agents_max` is shared evenly and a workspace with nothing waiting leaves
 * its share to the others. Ties go to the workspace whose turn on that account was longest ago, so
 * workspaces sharing an account take turns. Within a workspace the order is kept. Without `fair`
 * the order is the request order.
 */
export function fairOrder(
  waiting: readonly SlotRequest[],
  holders: readonly Holder[],
  turns: Turns,
  fair: boolean,
): SlotRequest[] {
  const owners = waiting.filter((w) => w.owner === true);
  const rest = waiting.filter((w) => w.owner !== true);
  if (!fair) return [...owners, ...rest];
  const wsOf = (r: SlotRequest): string => r.workspace ?? "";
  const count = new Map<string, number>();
  const acct = new Map<string, number>();
  const add = (r: SlotRequest): void => {
    count.set(wsOf(r), (count.get(wsOf(r)) ?? 0) + 1);
    const k = turnKey(r.account, wsOf(r));
    acct.set(k, (acct.get(k) ?? 0) + 1);
  };
  for (const h of holders) add(h);
  for (const o of owners) add(o);
  const left = [...rest];
  const out: SlotRequest[] = [...owners];
  while (left.length > 0) {
    // The first waiting start of each workspace keeps the workspace's own order.
    const heads = new Map<string, SlotRequest>();
    for (const r of left) if (!heads.has(wsOf(r))) heads.set(wsOf(r), r);
    let best: SlotRequest | undefined;
    let bestKey: number[] = [];
    for (const r of heads.values()) {
      const k = turnKey(r.account, wsOf(r));
      const key = [
        count.get(wsOf(r)) ?? 0,
        acct.get(k) ?? 0,
        turns.account.get(k) ?? -1,
        turns.workspace.get(wsOf(r)) ?? -1,
        waiting.indexOf(r),
      ];
      if (best === undefined || compare(key, bestKey) < 0) {
        best = r;
        bestKey = key;
      }
    }
    if (best === undefined) break;
    out.push(best);
    left.splice(left.indexOf(best), 1);
    add(best);
  }
  return out;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
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

/** The slots as they are now: who holds one and who waits in line. */
export interface SlotState {
  holders: readonly Pick<SlotRequest, "account">[];
  waiting: readonly Pick<SlotRequest, "account">[];
}

function room(inUse: number, waiting: number, limit: number): SlotRoom {
  return { inUse, waiting, limit, free: Math.max(0, limit - inUse - waiting) };
}

/**
 * Free slots overall and on each account. A start waiting in line counts like one holding a slot, so
 * a slot is free only when nobody is ahead for it. Idle holders count as in use: they keep their slot
 * until their idle timeout. `accounts` lists the accounts to report even when nothing uses them.
 */
export function capacityOf(
  state: SlotState,
  limits: Pick<Limits, "agents_max" | "per_account" | "runs_total">,
  accounts: readonly string[] = [],
): SlotCapacity {
  const names = [
    ...new Set([...accounts, ...state.holders.map((h) => h.account), ...state.waiting.map((w) => w.account)]),
  ];
  return {
    agents: room(state.holders.length, state.waiting.length, globalCap(limits)),
    accounts: names.sort().map((account) => ({
      account,
      ...room(
        state.holders.filter((h) => h.account === account).length,
        state.waiting.filter((w) => w.account === account).length,
        limits.per_account,
      ),
    })),
  };
}

function inUseLine(r: SlotRoom): string {
  return `${r.inUse} of ${r.limit} in use${r.waiting === 0 ? "" : `, ${r.waiting} waiting`}`;
}

/**
 * Why a start on these accounts would only wait in line, in one line, or undefined when each of them
 * and majhi as a whole have a free slot.
 */
export function noRoomLine(capacity: SlotCapacity, accounts: readonly string[]): string | undefined {
  for (const account of [...new Set(accounts)]) {
    const r = capacity.accounts.find((a) => a.account === account);
    if (r !== undefined && r.free === 0) return `No free slot on ${account}: ${inUseLine(r)}.`;
  }
  if (capacity.agents.free === 0) return `No free agent slot: ${inUseLine(capacity.agents)}.`;
  return undefined;
}

interface Waiter {
  req: SlotRequest;
  resolve: (granted: boolean) => void;
}

export interface SlotDeps {
  /** The limits now. Read each time, so changes apply live. */
  limits: () => Promise<Limits>;
  /** False when the holder cannot be stopped right now (it is between turns but still busy). */
  canEvict: (key: string) => boolean;
  /** Stops an idle holder's process. Its slot is already free when this is called. */
  evict: (key: string) => void;
  /** True while Autonomous is On: slots are shared fairly across workspaces. */
  fair?: () => boolean;
  /** The line changed: each waiting key and its 1-based place. */
  onQueue: (positions: Map<string, number>) => void;
  now?: () => number;
}

/** The slots in use and the line of starts waiting for one. */
export class Slots {
  private readonly holders = new Map<string, Holder>();
  private waiting: Waiter[] = [];
  private pumping: Promise<void> = Promise.resolve();
  private readonly turns: Turns = { workspace: new Map(), account: new Map() };
  private turn = 0;
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

  /** Who holds a slot and who waits, for `capacityOf`. */
  state(): SlotState {
    return { holders: [...this.holders.values()], waiting: this.waiting.map((w) => w.req) };
  }

  /** 1-based place in line, or undefined when not waiting. */
  position(key: string): number | undefined {
    const i = this.line().findIndex((w) => w.req.key === key);
    return i === -1 ? undefined : i + 1;
  }

  /** The waiting starts in the order they are served now (see `fairOrder`). */
  private line(): Waiter[] {
    const order = fairOrder(
      this.waiting.map((w) => w.req),
      [...this.holders.values()],
      this.turns,
      this.deps.fair?.() ?? false,
    );
    return order.flatMap((r) => this.waiting.filter((w) => w.req === r));
  }

  /** Looks at the line again, for example after the limits changed. */
  pump(): Promise<void> {
    this.pumping = this.pumping.then(() => this.pumpOnce()).catch(() => undefined);
    return this.pumping;
  }

  private async pumpOnce(): Promise<void> {
    if (this.waiting.length === 0) return;
    const limits = await this.deps.limits();
    let plan = planGrants(
      this.line().map((w) => w.req),
      [...this.holders.values()],
      limits,
    );
    // A holder that cannot be stopped after all counts as busy, and the line is planned again.
    for (let round = 0; round < 8; round++) {
      const refused = plan.evict.filter((key) => !this.deps.canEvict(key));
      if (refused.length === 0) break;
      for (const key of refused) {
        const holder = this.holders.get(key);
        if (holder !== undefined) holder.busy = true;
      }
      plan = planGrants(
        this.line().map((w) => w.req),
        [...this.holders.values()],
        limits,
      );
    }
    for (const key of plan.evict) {
      this.holders.delete(key);
      this.deps.evict(key);
    }
    for (const key of plan.grant) {
      const waiter = this.waiting.find((w) => w.req.key === key);
      if (waiter === undefined) continue;
      this.waiting = this.waiting.filter((w) => w !== waiter);
      this.holders.set(key, { ...waiter.req, busy: true, lastUsed: this.now() });
      this.turn += 1;
      const ws = waiter.req.workspace ?? "";
      this.turns.workspace.set(ws, this.turn);
      this.turns.account.set(turnKey(waiter.req.account, ws), this.turn);
      waiter.resolve(true);
    }
    this.deps.onQueue(new Map(this.line().map((w, i) => [w.req.key, i + 1])));
  }
}

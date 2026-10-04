import type { AccountStatus, QueueItem } from "@majhi/shared";

/**
 * Queue items that wait for an account (SPEC 5.18). The captain states the condition once; majhi
 * reads the account each minute, so a belief like "umbrella is signed out" never outlives the fact.
 * Pure.
 */

/** Account states in which the account is signed in and reachable. */
const SIGNED_IN: readonly AccountStatus[] = ["healthy", "running-high", "relogin-soon", "at-limit"];

type Wait = NonNullable<QueueItem["waitFor"]>;

/** Whether the account's state meets the wait. A state not known yet (never checked) meets nothing. */
export function meets(wait: Wait, status: AccountStatus | undefined, full = false): boolean {
  if (status === undefined || !SIGNED_IN.includes(status)) return false;
  if (wait.state === "signed-in") return true;
  // "available" also needs a free per-account slot: starting refuses while it is full.
  return status !== "at-limit" && !full;
}

/** The account's state in words. */
export function stateWords(status: AccountStatus | undefined): string {
  switch (status) {
    case "healthy":
    case "running-high":
    case "relogin-soon":
      return "signed in";
    case "at-limit":
      return "signed in but at its limit";
    case "needs-login":
      return "signed out";
    case "unreachable":
      return "unreachable";
    default:
      return "not checked yet";
  }
}

export interface Lifted {
  item: QueueItem;
  /** The one line the captain is woken with. */
  line: string;
}

/**
 * Sets `readyAt` on the items whose wait is met now and clears it on those whose wait is not met any
 * more. `lifted` has a line for each item that became ready in this look. `paused`: the task is
 * paused, so it "can resume" rather than "can start".
 */
export function evaluateWaits(
  queue: readonly QueueItem[],
  statusOf: (account: string) => AccountStatus | undefined,
  now: Date,
  paused: (task: string) => boolean,
  fullOf: (account: string) => boolean = () => false,
): { queue: QueueItem[]; lifted: Lifted[]; changed: boolean } {
  const lifted: Lifted[] = [];
  let changed = false;
  const next = queue.map((item) => {
    const wait = item.waitFor;
    if (wait === undefined) return item;
    const ok = meets(wait, statusOf(wait.account), fullOf(wait.account));
    if (ok && item.readyAt === undefined) {
      changed = true;
      const ready = { ...item, readyAt: now.toISOString() };
      const what =
        item.task === undefined
          ? `"${item.title}" can start`
          : `${item.task} can ${paused(item.task) ? "resume" : "start"}`;
      lifted.push({
        item: ready,
        line: `${wait.account} is ${wait.state === "signed-in" ? "signed in" : "available"} again: ${what}`,
      });
      return ready;
    }
    if (!ok && item.readyAt !== undefined) {
      changed = true;
      const { readyAt: _gone, ...rest } = item;
      return rest;
    }
    return item;
  });
  return { queue: next, lifted, changed };
}

/**
 * Why a plan item cannot wait: its account does not exist, or already meets the wait, so waiting
 * would repeat a belief that is no longer true. Undefined when the wait is real.
 */
export function waitProblem(
  item: QueueItem,
  statusOf: (account: string) => AccountStatus | undefined,
  known: (account: string) => boolean,
  fullOf: (account: string) => boolean = () => false,
): string | undefined {
  const wait = item.waitFor;
  if (wait === undefined) return undefined;
  if (!known(wait.account))
    return `There is no account ${wait.account}. Check majhi_accounts_list for the ids.`;
  const status = statusOf(wait.account);
  if (!meets(wait, status, fullOf(wait.account))) return undefined;
  const what = item.task === undefined ? `"${item.title}"` : item.task;
  return `${wait.account} is ${stateWords(status)} right now, so ${what} does not wait for it. Start or resume it now instead of planning around it.`;
}

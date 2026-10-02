import { type ApprovalStats, type CardCounts, countCard, EMPTY_COUNTS } from "@majhi/shared";
import type { RoomRepo } from "../store/room.ts";

const STATES = new Set(["pending", "applied", "rejected", "failed", "undone"] as const);
type CardState = typeof STATES extends Set<infer S> ? S : never;
const isState = (s: string): s is CardState => (STATES as Set<string>).has(s);

/**
 * Approval cards of the last `days` days per command, most shown first: what the owner was asked
 * and what came of it. `now` is a parameter so tests pick the window.
 */
export function cardStats(room: RoomRepo, days: number, now = Date.now()): ApprovalStats {
  const since = new Date(now - days * 86_400_000).toISOString();
  const byCommand = new Map<string, CardCounts>();
  for (const row of room.approvalCounts(since)) {
    if (!isState(row.state)) continue;
    byCommand.set(
      row.command,
      countCard(byCommand.get(row.command) ?? EMPTY_COUNTS, row.state, row.alone, row.n),
    );
  }
  const list = [...byCommand].map(([command, counts]) => ({ command, ...counts }));
  list.sort((a, b) => b.shown - a.shown || a.command.localeCompare(b.command));
  return { days, since, commands: list };
}

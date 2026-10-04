import { createHash } from "node:crypto";

/**
 * The captain's report to the owner in the root chat (the "All" lane): one line per workspace, made
 * from data with no model turn. This file is the pure rule: what the text says, and when a post is
 * due. Reading the data and writing the room item are in `service.ts`.
 */

/** A scheduled post every this often while Auto-pilot is on. */
export const PERIODIC_MS = 3 * 60 * 60_000;
/** Posts that report an event are batched: at most one in this long. */
export const NOTABLE_MS = 15 * 60_000;
/** An item waiting on the owner this long is an event of its own. */
export const LATE_MS = 2 * 60 * 60_000;

export interface OrgFacts {
  org: string;
  name: string;
  /** Tasks that shipped or opened an MR since the last post. */
  moved: { id: string; title: string; what: "shipped" | "MR opened" }[];
  stuck: { id: string; why: string }[];
  /** Pending items for the owner. `lane` is an item in the workspace's captain lane. */
  waiting: { id: string; kind: string; since: number; lane: boolean }[];
}

export interface Facts {
  orgs: OrgFacts[];
  incidents: { id: number; title: string }[];
  /** Workspaces (or "The day budget") that used their cap today. */
  capsHit: string[];
  /** "Spend today: $4.20 of $20.", or empty. */
  spend: string;
}

export interface Rollup {
  text: string;
  /** Of the content without the spend line and the ages, so those alone never make a new post. */
  hash: string;
  /** What is new to the owner: events that can start a post of their own. */
  keys: string[];
}

function age(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min}m` : min < 48 * 60 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`;
}

function orgLine(o: OrgFacts, now: number): string | undefined {
  const parts: string[] = [];
  if (o.moved.length > 0) parts.push(o.moved.map((m) => `${m.what} ${m.id} ${m.title}`).join(", "));
  if (o.stuck.length > 0) parts.push(`Stuck: ${o.stuck.map((s) => `${s.id} ${s.why}`).join(", ")}`);
  const own = o.waiting.filter((w) => !w.lane);
  if (own.length > 0) {
    const oldest = Math.min(...own.map((w) => w.since));
    parts.push(
      `Needs you: ${own.length}, oldest ${age(now - oldest)} (${[...new Set(own.map((w) => w.id))].join(", ")})`,
    );
  }
  for (const w of o.waiting.filter((x) => x.lane)) parts.push(`The lane left a ${w.kind} for you in ${w.id}`);
  return parts.length === 0 ? undefined : `${o.name}: ${parts.join(". ")}.`;
}

export function rollupOf(facts: Facts, now: number): Rollup {
  const lines: string[] = [];
  for (const o of facts.orgs) {
    const line = orgLine(o, now);
    if (line !== undefined) lines.push(line);
  }
  for (const i of facts.incidents) lines.push(`Incident open: ${i.title}.`);
  for (const c of facts.capsHit) lines.push(`${c} used its daily cap.`);
  const body =
    lines.length === 0 ? "Nothing moved, nothing is stuck, nothing waits for you." : lines.join("\n");
  const keys: string[] = [];
  for (const o of facts.orgs) {
    for (const m of o.moved) keys.push(`moved:${m.id}:${m.what}`);
    for (const w of o.waiting) {
      if (w.lane) keys.push(`lane:${w.id}:${w.kind}`);
      else if (now - w.since >= LATE_MS) keys.push(`late:${w.id}:${w.kind}`);
    }
  }
  for (const i of facts.incidents) keys.push(`incident:${i.id}`);
  for (const c of facts.capsHit) keys.push(`cap:${c}`);
  return {
    hash: createHash("sha256")
      .update(body.replace(/oldest \d+[mhd]/g, "oldest"))
      .digest("hex")
      .slice(0, 12),
    text: ["Captain update.", body, facts.spend].filter((l) => l !== "").join("\n"),
    keys,
  };
}

export type PostWhy = "morning" | "periodic" | "notable";

export interface RollupState {
  hash?: string | undefined;
  /** When the last post was made. */
  postedAt?: number | undefined;
  notableAt?: number | undefined;
  /** The local day the morning post was last due for. */
  morningDay?: string | undefined;
  /** When a scheduled post was last due, posted or not. */
  checkedAt?: number | undefined;
  /** Events already reported. */
  seen: readonly string[];
}

export interface Clock {
  now: number;
  /** The owner's local day and `HH:MM`. */
  day: string;
  clock: string;
  morningAt: string;
  autopilot: boolean;
}

/**
 * Whether a post is due now, and the state after looking. The same content as the last post posts
 * nothing, but the schedule moves on. An event inside the 15 minute throttle waits, unmarked, and
 * the next post reports it with the others.
 */
export function step(s: RollupState, c: Clock, r: Rollup): { state: RollupState; post?: PostWhy } {
  const fresh = r.keys.some((k) => !s.seen.includes(k));
  const morning = s.morningDay !== c.day && c.clock >= c.morningAt;
  const last = s.checkedAt ?? s.postedAt;
  const periodic = c.autopilot && (last === undefined || c.now - last >= PERIODIC_MS);
  const notable = fresh && (s.notableAt === undefined || c.now - s.notableAt >= NOTABLE_MS);
  if (!morning && !periodic && !notable) return { state: s };
  const why: PostWhy = morning ? "morning" : notable ? "notable" : "periodic";
  const next: RollupState = {
    ...s,
    seen: r.keys,
    ...(morning ? { morningDay: c.day } : {}),
    ...(morning || periodic ? { checkedAt: c.now } : {}),
  };
  if (r.hash === s.hash) return { state: next };
  return {
    state: { ...next, hash: r.hash, postedAt: c.now, ...(why === "notable" ? { notableAt: c.now } : {}) },
    post: why,
  };
}

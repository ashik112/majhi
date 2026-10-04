import { type AutonomyMode, type AutonomySpend, type Budget, PRIVATE } from "@majhi/shared";
import { zoneOr } from "../autonomy/service.ts";
import type { ConfigService } from "../config/service.ts";
import type { RoomPayload, Store } from "../store/index.ts";
import { localDay } from "../usage/ranges.ts";
import type { Lanes } from "./lanes.ts";
import { workspaceIds } from "./levels.ts";
import { type Facts, type OrgFacts, type PostWhy, type RollupState, rollupOf, step } from "./rollup.ts";

export interface RollupDeps {
  store: Store;
  config: ConfigService;
  lanes: Lanes;
  mode: () => AutonomyMode;
  /** Today's spend and caps. */
  spend: () => Promise<AutonomySpend>;
  /** Open high incidents nobody acknowledged. */
  incidents: () => { id: number; title: string }[];
  /** The owner's current captain chat and the captain's agent id, or undefined when there is none yet. */
  bossChat: () => Promise<{ chat: string; agent: string } | undefined>;
  post: (task: string, id: string, payload: RoomPayload) => void;
  now: () => Date;
}

const DAY_MS = 24 * 60 * 60_000;
const STUCK: Record<string, string> = {
  limit: "paused, account at its limit",
  offline: "paused, offline",
  error: "paused after an error",
  loop: "paused, agents went in circles",
  blocked: "paused, waits on another task",
  "signed-out": "paused, account signed out",
  owner: "paused",
};
const KIND: Record<string, string> = {
  approval: "approval",
  permission: "permission",
  "secret-request": "secret",
  ask: "question",
  choice: "question",
  "owner-question": "question",
  review: "review",
};

function money(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function spendLine(s: AutonomySpend): string {
  const cap = (b: Budget | undefined, used: { tokens: number; cost: number }) => {
    if (b?.cost !== undefined) return ` of ${money(b.cost)}`;
    if (b?.tokens !== undefined) return ` of ${Math.round(b.tokens / 1000)}k tokens`;
    return "";
  };
  const used =
    s.total.cap?.cost === undefined && s.total.cap?.tokens !== undefined
      ? `${Math.round(s.total.used.tokens / 1000)}k tokens`
      : money(s.total.used.cost);
  return `Spend today: ${used}${cap(s.total.cap, s.total.used)}.`;
}

/**
 * Posts the captain's roll-up into the root chat from the minute sweep. No model turn: the text is
 * made from the board (`rollupOf`), and `step` decides whether one is due.
 */
const READ_EVERY_MS = 5 * 60_000;

export class RollupPoster {
  private readonly states = new Map<string, RollupState>();
  /** When the board was last read: every 5 minutes is enough, and reading every task each minute costs. */
  private lastRead = 0;

  constructor(private readonly deps: RollupDeps) {}

  async sweep(): Promise<string | undefined> {
    const at = this.deps.now().getTime();
    if (at - this.lastRead < READ_EVERY_MS) return undefined;
    this.lastRead = at;
    const boss = await this.deps.bossChat();
    if (boss === undefined) return undefined;
    const settings = (await this.deps.config.settings()).autonomy;
    const tz = zoneOr(settings.tz);
    const now = this.deps.now();
    const state = this.states.get(boss.chat) ?? this.hydrate(boss.chat, tz);
    const clock = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
    const since = state.postedAt ?? now.getTime() - DAY_MS;
    const spend = await this.deps.spend().catch(() => undefined);
    const facts = await this.facts(since, spend);
    const rollup = rollupOf(facts, now.getTime());
    const out = step(
      state,
      {
        now: now.getTime(),
        day: localDay(now, tz),
        clock,
        morningAt: settings.summary_at,
        autopilot: this.deps.mode() === "on",
      },
      rollup,
    );
    this.states.set(boss.chat, out.state);
    if (out.post === undefined) return undefined;
    this.deps.post(boss.chat, `rollup:${out.post}:${rollup.hash}:${now.getTime()}`, {
      type: "agent",
      agent: boss.agent,
      text: rollup.text,
    });
    return rollup.text;
  }

  /**
   * A workspace captain finished a turn: its message to the owner shows in the root chat as it lands,
   * one short line with the workspace and the thread to read the rest in, so the owner never has to
   * watch every thread.
   */
  async relay(lane: string, text: string): Promise<void> {
    const org = this.deps.lanes.orgOf(lane);
    if (org === undefined) return;
    const boss = await this.deps.bossChat();
    if (boss === undefined || boss.chat === lane) return;
    const line = relayLine(text);
    if (line === "") return;
    const sections = await this.deps.config.sections();
    const name = org === PRIVATE ? "Private" : (sections.orgs[org]?.name ?? org);
    const at = this.deps.now().getTime();
    this.deps.post(boss.chat, `relay:${lane}:${at}`, {
      type: "agent",
      agent: boss.agent,
      text: `**${name}** (${lane}): ${line}`,
    });
  }

  /** After a restart: what the chat's own earlier roll-ups say about the schedule. */
  private hydrate(chat: string, tz: string): RollupState {
    const rows = this.deps.store.raw
      .prepare(
        "SELECT id, at FROM room_items WHERE task = ? AND id LIKE 'rollup:%' ORDER BY seq DESC LIMIT 60",
      )
      .all(chat) as { id: string; at: string }[];
    const state: {
      -readonly [K in keyof RollupState]: RollupState[K];
    } = { seen: [] };
    for (const row of rows) {
      const [, why, hash] = row.id.split(":") as [string, PostWhy | undefined, string | undefined];
      const at = Date.parse(row.at);
      if (Number.isNaN(at)) continue;
      if (state.postedAt === undefined) {
        state.postedAt = at;
        state.hash = hash;
      }
      if (why === "notable" && state.notableAt === undefined) state.notableAt = at;
      if (why === "morning" && state.morningDay === undefined) state.morningDay = localDay(new Date(at), tz);
    }
    this.states.set(chat, state);
    return state;
  }

  private async facts(since: number, spend: AutonomySpend | undefined): Promise<Facts> {
    const sections = await this.deps.config.sections();
    const names = new Map<string, string>([
      [PRIVATE, "Private"],
      ...Object.entries(sections.orgs).map(([id, o]) => [id, o.name] as [string, string]),
    ]);
    const orgs = new Map<string, OrgFacts>(
      workspaceIds(sections.orgs).map((org) => [
        org,
        { org, name: names.get(org) ?? org, moved: [], stuck: [], waiting: [] },
      ]),
    );
    const tasks = this.deps.store.tasks.list(true);
    const known = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      if (t.kind === "chat") continue;
      const o = orgs.get(t.org ?? PRIVATE);
      if (o === undefined) continue;
      const moved = Date.parse(t.updatedAt) >= since;
      if (t.status === "done" && moved) o.moved.push({ id: t.id, title: t.title, what: "shipped" });
      else if (t.status === "mr" && moved) o.moved.push({ id: t.id, title: t.title, what: "MR opened" });
      else if (t.status === "paused" && t.pausedReason !== undefined)
        o.stuck.push({ id: t.id, why: STUCK[t.pausedReason] ?? "paused" });
    }
    for (const item of this.deps.store.room.waitingDecisions()) {
      if (item.type === "paused") continue;
      const lane = this.deps.lanes.orgOf(item.task);
      const org = lane ?? known.get(item.task)?.org ?? (known.has(item.task) ? PRIVATE : undefined);
      const o = org === undefined ? undefined : orgs.get(org);
      if (o === undefined) continue;
      if (lane === undefined && known.get(item.task)?.kind === "chat") continue;
      o.waiting.push({
        id: item.task,
        kind: KIND[item.type] ?? "question",
        since: Date.parse(item.at),
        lane: lane !== undefined,
      });
    }
    const capsHit: string[] = [];
    if (spend?.total.reached === true) capsHit.push("The day budget");
    for (const u of spend?.orgs ?? []) {
      if (u.reached) capsHit.push(names.get(u.org) ?? u.org);
    }
    return {
      orgs: [...orgs.values()],
      incidents: this.deps.incidents(),
      capsHit,
      spend: spend === undefined ? "" : spendLine(spend),
    };
  }
}

/** The first paragraph of a lane message, without markdown headings, at most about 320 characters. */
export function relayLine(text: string): string {
  const first =
    text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^#+\s*/gm, "").trim())
      .find((p) => p !== "") ?? "";
  const flat = first.replace(/\s*\n\s*/g, " ");
  if (flat.length <= 320) return flat;
  const cut = flat.slice(0, 320);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return `${cut.slice(0, end > 200 ? end + 1 : 320).trim()} …`;
}

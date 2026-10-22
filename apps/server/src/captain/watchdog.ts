import { LANE_HEAL_MS, lifecycle, type RoomItem, type Task, type TaskId } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { RoomRow } from "../store/client.ts";
import type { Store } from "../store/index.ts";
import type { Lanes } from "./lanes.ts";

/**
 * The lane watchdog (docs/briefs/case-flow.md, "Self-healing"). A timer that stands apart from the captain, the lanes
 * and the runs: when a client message has waited more than two minutes and no captain turn runs for its workspace, it
 * heals the lane by the typed cause it stopped for, and when the message is still unanswered ten minutes after it
 * arrived it tells the owner once, through the owner's own notification path, what was tried. A lane the owner
 * stopped is never resumed.
 */

/** How long a client message waits before the watchdog looks, and before it tells the owner. */
export const WATCH_AFTER_MS = 2 * 60_000;
export const ALERT_AFTER_MS = LANE_HEAL_MS;
/** The wait before the second and the third resume of a lane that stopped with an error. */
export const RESUME_BACKOFF_MS = [60_000, 180_000, 360_000] as const;
const MAX_RESUMES = 3;

/** The words a client reads when nobody has answered in time. Fixed: no model writes it. */
export const FALLBACK_TEXT = "We're looking into it.";

function withoutStop(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

/** A client message that waits for the captain: its outcome is typed, so no text is read. */
export interface Waiting {
  room: RoomRow;
  item: Extract<RoomItem, { type: "client" }>;
  since: number;
}

export interface WatchdogDeps {
  store: Store;
  lanes: Pick<Lanes, "chat" | "account" | "boss" | "ensure">;
  tasks: {
    holdOf(id: string): lifecycle.Hold | undefined;
    start(id: string, by: string): Promise<unknown>;
  };
  /** Why the lane stopped, in the words its own card gives (the error, the sign-in), or undefined when it has none. */
  stoppedBecause: (chat: string) => string | undefined;
  /** Whether a captain turn runs in this lane chat now. */
  turnRunning: (chat: string) => boolean;
  room: Pick<RoomService, "post" | "get">;
  /** The open case of a chat today: the room the heals are written in. */
  caseOf: (room: string) => Promise<string | undefined>;
  /** Whether a message waits for the captain: the desk's own reading of its outcome. */
  waits: (item: Extract<RoomItem, { type: "client" }>) => boolean;
  /** Wakes again the messages that could not be woken: the desk's own retry, once a lane takes a wake. */
  retry: () => void;
  /** Puts a message in front of the captain's lane again. */
  nudge: (room: RoomRow, item: Extract<RoomItem, { type: "client" }>) => void;
  /** The fixed words to the client. */
  tellClient: (room: RoomRow, text: string) => Promise<unknown>;
  /** The owner's own path: the phone push and the Telegram message, whichever is set up. */
  tellOwner: (title: string, text: string) => Promise<void>;
  changed: () => void;
  now?: () => Date;
}

/** What was tried for a workspace's waiting messages. In memory: a restart starts the count again. */
interface Tried {
  resumes: number;
  switches: number;
  nudges: number;
  lastAt: number;
  /** Why the lane cannot take the message, in the owner's words. */
  cause: string;
  /** The hold the cause was read for: another hold is another cause. */
  holdCause: string;
}

export class LaneWatchdog {
  private readonly tried = new Map<string, Tried>();

  constructor(private readonly deps: WatchdogDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The client messages of captain-held chats that wait for the captain, by workspace. */
  private waiting(): Map<string, Waiting[]> {
    const out = new Map<string, Waiting[]>();
    for (const room of this.deps.store.client.rooms()) {
      if (room.org === undefined || room.chat.holder !== "captain" || room.chat.archived === true) continue;
      for (const item of this.deps.store.room.page(room.id, 60).items) {
        if (item.type !== "client" || item.us === true || !this.deps.waits(item)) continue;
        const list = out.get(room.org) ?? [];
        list.push({ room, item, since: Date.parse(item.sentAt ?? item.at) });
        out.set(room.org, list);
      }
    }
    return out;
  }

  /** One pass. Never throws: the next pass tries again. */
  async sweep(at: Date = this.now()): Promise<void> {
    const waiting = this.waiting();
    for (const org of [...this.tried.keys()]) if (!waiting.has(org)) this.tried.delete(org);
    for (const [org, list] of waiting) {
      try {
        const oldest = Math.min(...list.map((w) => w.since));
        const age = at.getTime() - oldest;
        if (age < WATCH_AFTER_MS) continue;
        const lane = this.deps.lanes.chat(org, "reacting");
        // A turn that runs is the captain at work: the lane is well, and the desk settles what it reads.
        if (
          [lane, this.deps.lanes.chat(org, "backlog")].some(
            (c) => c !== undefined && this.deps.turnRunning(c),
          )
        )
          continue;
        await this.heal(org, list, lane, at);
        if (age >= ALERT_AFTER_MS) await this.alert(org, list, lane, at);
      } catch (err) {
        console.log(`watchdog: ${org}: ${errorMessage(err)}`);
      }
    }
  }

  private triedOf(org: string): Tried {
    const found = this.tried.get(org) ?? {
      resumes: 0,
      switches: 0,
      nudges: 0,
      lastAt: 0,
      cause: "",
      holdCause: "",
    };
    this.tried.set(org, found);
    return found;
  }

  /** Whether the next attempt may be made: not before the backoff of the attempts so far has passed. */
  private due(tried: Tried, attempts: number, at: Date): boolean {
    if (attempts >= MAX_RESUMES) return false;
    return attempts === 0 || at.getTime() - tried.lastAt >= (RESUME_BACKOFF_MS[attempts - 1] ?? 0);
  }

  /** Where a line about this heal is written: the open case of the chat, else the lane. */
  private async said(w: Waiting, lane: string | undefined, id: string, text: string): Promise<void> {
    const task = (await this.deps.caseOf(w.room.id)) ?? lane;
    if (task === undefined) return;
    this.deps.room.post(task as TaskId, id, { type: "system", level: "info", text });
  }

  private async healed(list: Waiting[], lane: string | undefined, n: number, cause: string): Promise<void> {
    const first = list[0];
    if (first === undefined) return;
    await this.said(first, lane, `heal:${first.item.id}:${n}`, `majhi restarted the captain: ${cause}`);
    // The lane takes wakes again: messages that could not be woken are woken by the desk's retry, and those whose wake
    // was lost with the lane (still `working`) are put in front of it again.
    this.deps.retry();
    for (const w of list) if (w.item.outcome?.state === "working") this.deps.nudge(w.room, w.item);
    this.deps.changed();
  }

  private async heal(org: string, list: Waiting[], lane: string | undefined, at: Date): Promise<void> {
    const tried = this.triedOf(org);
    const boss = await this.deps.lanes.boss();
    if (lane === undefined) {
      // The lane was never made, or its record is gone: make it, and put the messages in front of it.
      if (!this.due(tried, tried.nudges, at)) return;
      tried.nudges += 1;
      tried.lastAt = at.getTime();
      tried.cause = "the captain's lane did not exist";
      await this.deps.lanes.ensure(org, "reacting");
      for (const w of list) this.deps.nudge(w.room, w.item);
      await this.healed(list, undefined, tried.resumes + tried.nudges + tried.switches, tried.cause);
      return;
    }
    const task: Task | undefined = this.deps.store.tasks.get(lane);
    if (task === undefined) return;
    const hold = this.deps.tasks.holdOf(lane);
    if (hold !== undefined) {
      await this.healHold(org, list, lane, hold, boss, tried, at);
      return;
    }
    if (task.status === "done") {
      if (!this.due(tried, tried.resumes, at)) return;
      tried.resumes += 1;
      tried.lastAt = at.getTime();
      tried.cause = "the captain's lane was closed";
      await this.deps.lanes.ensure(org, "reacting");
      for (const w of list) this.deps.nudge(w.room, w.item);
      await this.healed(list, lane, tried.resumes + tried.nudges + tried.switches, tried.cause);
      return;
    }
    // Not stopped, and no turn runs: a wake was lost. Put the messages in front of the lane again.
    if (!this.due(tried, tried.nudges, at)) return;
    tried.nudges += 1;
    tried.lastAt = at.getTime();
    tried.cause = "a message did not reach the captain";
    for (const w of list) this.deps.nudge(w.room, w.item);
    await this.healed(list, lane, tried.resumes + tried.nudges + tried.switches, tried.cause);
  }

  /** A lane that is held: healed by the typed cause. What the owner stopped stays stopped. */
  private async healHold(
    org: string,
    list: Waiting[],
    lane: string,
    hold: lifecycle.Hold,
    boss: string | undefined,
    tried: Tried,
    at: Date,
  ): Promise<void> {
    // The hold's cause says what to do; the lane's own card says why, in words. Read once per hold, so what a failed
    // resume added to it stays.
    if (tried.holdCause !== hold.cause) {
      tried.holdCause = hold.cause;
      tried.cause = this.deps.stoppedBecause(lane) ?? lifecycle.sentenceOf(hold);
    }
    const lifters = lifecycle.liftersOf(hold);
    if (hold.cause === "error") {
      if (boss === undefined || !lifters.includes("captain") || !this.due(tried, tried.resumes, at)) return;
      tried.resumes += 1;
      tried.lastAt = at.getTime();
      try {
        await this.deps.tasks.start(lane, boss);
      } catch (err) {
        tried.cause = `${tried.cause} (${errorMessage(err)})`;
        return;
      }
      await this.healed(list, lane, tried.resumes + tried.switches, tried.cause);
      return;
    }
    if (hold.cause === "signed-out" || hold.cause === "account-limit" || hold.cause === "agents-down") {
      if (!lifters.includes("majhi") || !this.due(tried, tried.switches, at)) return;
      tried.switches += 1;
      tried.lastAt = at.getTime();
      // The lane runs on the captain's account, then the fallback's, then any other that is healthy and allowed here.
      const picked = await this.deps.lanes.account(org);
      if ("problem" in picked) {
        tried.cause = `${tried.cause} No account can run it: ${picked.problem}.`;
        return;
      }
      try {
        await this.deps.tasks.start(lane, "majhi");
      } catch (err) {
        tried.cause = `${tried.cause} (${errorMessage(err)})`;
        return;
      }
      await this.healed(
        list,
        lane,
        tried.resumes + tried.switches,
        `${tried.cause} It runs on ${picked.account} now`,
      );
    }
  }

  /** Ten minutes and still unanswered: one message to the owner per case, once, and the client's fixed words. */
  private async alert(org: string, list: Waiting[], lane: string | undefined, at: Date): Promise<void> {
    const first = [...list].sort((a, b) => a.since - b.since)[0];
    if (first === undefined) return;
    const tried = this.triedOf(org);
    const task = (await this.deps.caseOf(first.room.id)) ?? lane;
    const marker = `alert:${first.item.id}`;
    // One message per case: the marker in the case's room (or the lane's) says it was told.
    if (task === undefined || this.deps.room.get(task as TaskId, marker) !== undefined) return;
    const minutes = Math.floor((at.getTime() - first.since) / 60_000);
    const done = [
      tried.resumes > 0 ? `resume ×${tried.resumes}` : undefined,
      tried.switches > 0 ? "account switch" : undefined,
      tried.nudges > 0 ? `wake again ×${tried.nudges}` : undefined,
    ].filter((t): t is string => t !== undefined);
    const text = `${first.item.sender.name} wrote ${minutes} min ago in ${first.room.chat.title}; the captain could not start: ${tried.cause === "" ? "it did not take the message" : withoutStop(tried.cause)}; tried: ${done.length === 0 ? "nothing it could" : done.join(", ")}.`;
    this.deps.room.post(task as TaskId, marker, {
      type: "system",
      level: "warn",
      text: `majhi told you: ${text}`,
    });
    await this.deps.tellOwner("A client is waiting", text).catch(() => undefined);
    await this.deps.tellClient(first.room, FALLBACK_TEXT).catch(() => undefined);
    this.deps.changed();
  }
}

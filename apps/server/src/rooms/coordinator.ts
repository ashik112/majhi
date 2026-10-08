import { createHash, randomUUID } from "node:crypto";
import {
  type AgentFrontmatter,
  canWorkIn,
  type DecideRequestInput,
  isCaptainLane,
  OWNER_HANDLE,
  parseMentions,
  type RoomItem,
  type Task,
  type TaskId,
} from "@majhi/shared";
import { isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import type { CaptainHears } from "../captain/hears.ts";
import type { ConfigService } from "../config/service.ts";
import type { Decisions } from "../decisions/api.ts";
import { UserError } from "../errors.ts";
import { git } from "../git/git.ts";
import type { RoomService } from "../room/service.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { readChoices } from "./choices.ts";
import {
  asksOwner,
  loopPair,
  type Member,
  ownerQuestion,
  planTurn,
  routesMentions,
  statusOnly,
  unreviewed,
  type Verdict,
  verdictOf,
  waitsOnly,
} from "./coordinate.ts";
import {
  addresses,
  asksByWords,
  key as mentionKey,
  mentionQuestion,
  notAddedNote,
  QUIET_ON_NO,
  quietNote,
  readMentions,
} from "./mentions.ts";

/** How much of a message the decision provider reads. */
const STATE_MAX = 2000;
/** read_recent cuts each message to this, in the middle. */
const READ_ITEM_MAX = 1200;

export interface CoordinatorDeps {
  store: Store;
  room: RoomService;
  runs: RunManager;
  tasks: TaskService;
  agents: AgentStore;
  config: ConfigService;
  decisions?: Decisions | undefined;
  /** What a worker says to the captain about its task: the captain's lane hears it, and the captain never joins the team. */
  hears?: Pick<CaptainHears, "hear"> | undefined;
  /** Whether the agent waits on a background run it started (`wait: true`): then it asks nobody. */
  waitsOnProcess?: ((task: string, agent: string) => boolean) | undefined;
  /** The agent's account when it needs a new sign-in: no work is handed to such an agent. */
  signedOut?: ((agent: string) => Promise<string | undefined>) | undefined;
}

/** The line that refuses a handoff to an agent whose account needs a new sign-in. */
export function signedOutRefusal(agent: string, account: string): string {
  return `@${agent} cannot run: its account ${account} needs a new sign-in. Give the step to another teammate.`;
}

/**
 * Teams in a room (SPEC 5.3). When an agent ends a turn, reads the @mentions in its final message,
 * adds mentioned agents that may join, works out who goes next for the task's mode, and hands the
 * work on with a handoff prompt. Stops the room when the loop guard or the review round cap says
 * so. Asks the decision provider only when the words alone do not say what a reviewer decided.
 */
export class RoomCoordinator {
  /** (task, agent) pairs that posted an ask card in the turn now running. */
  private readonly askedInTurn = new Set<string>();
  /** (task, agent) pairs told that a mention of theirs woke nobody, until their next turn ends. */
  private readonly quietNoted = new Set<string>();
  /** Who each (task, agent) handed work to with the mention tool in the turn now running. */
  private readonly toolHandoffs = new Map<string, Set<string>>();
  /** (task, agent) pairs told that a teammate they handed to cannot sign in, until their next turn ends. */
  private readonly signInNoted = new Set<string>();

  constructor(private readonly deps: CoordinatorDeps) {}

  async turnEnded(turn: { task: string; agent: string; text: string }): Promise<void> {
    const { store, runs } = this.deps;
    const asked = this.askedInTurn.delete(`${turn.task}\u0000${turn.agent}`);
    // This turn answered a "not woken" note: it gets no second one.
    const answersNote = this.quietNoted.delete(`${turn.task}\u0000${turn.agent}`);
    const answersSignIn = this.signInNoted.delete(`${turn.task}\u0000${turn.agent}`);
    // Teammates this turn already handed work to with the tool: its closing message does not wake them twice.
    const handedByTool = this.toolHandoffs.get(`${turn.task}\u0000${turn.agent}`) ?? new Set<string>();
    this.toolHandoffs.delete(`${turn.task}\u0000${turn.agent}`);
    let task = store.tasks.get(turn.task);
    if (task !== undefined && isCaptainLane(task) && task.team.includes(turn.agent)) {
      // The captain's question in its lane reaches Needs you from the end of its turn, as an owner's chat does not.
      const text = turn.text.trim();
      if (!asked && text !== "" && asksOwner(text)) this.postQuestion(task.id, turn.agent, text);
      else this.movedOn(task.id, turn.agent);
      return;
    }
    if (task === undefined || isBossChat(task)) return;
    if (task.status !== "running") {
      // In review or paused nothing is handed on, but a question the agent did not ask again no
      // longer waits: a stale card would hold the ship, and the agent cannot see or answer it.
      const again = parseMentions(turn.text, []).includes(OWNER_HANDLE) || asksOwner(turn.text);
      if (!again) this.movedOn(task.id, turn.agent);
      return;
    }
    // Taken off the team: what it still says is posted, but it hands nothing on.
    if (!task.team.includes(turn.agent)) return;
    const text = turn.text.trim();
    const agents = await this.frontmatters();
    const boss = (await this.deps.config.sections()).boss;
    const named_ = parseMentions(
      text,
      agents.map((a) => a.id),
    ).filter((m) => m !== turn.agent);
    // The captain is not a teammate: a worker's words to it wake its workspace lane about this task.
    const mentions = named_.filter((m) => m !== boss);
    if (boss !== undefined && named_.includes(boss) && addresses(text, boss))
      await this.deps.hears?.hear(task, { kind: "agent", id: turn.agent }, text);
    const removed = store.tasks.roomState(task.id).removed ?? [];
    const joined = new Set<string>();
    // Agents that could have joined but were named in passing: the writer is told they did not.
    const notAdded: string[] = [];

    // An agent addressed from outside the team joins when it may work in the org. A name in
    // passing does not add anyone. One the owner removed stays out: only the owner brings it back.
    for (const m of mentions) {
      if (m === OWNER_HANDLE || task.team.includes(m) || removed.includes(m)) continue;
      const fm = agents.find((a) => a.id === m);
      if (!addresses(text, m)) {
        if (fm !== undefined && canWorkIn(fm, task.org)) notAdded.push(m);
        continue;
      }
      if (fm !== undefined && canWorkIn(fm, task.org)) {
        task = await this.deps.tasks.addToTeam(task.id, m, { by: turn.agent });
        joined.add(m);
      } else {
        this.say(
          task.id,
          "warn",
          `@${turn.agent} mentioned @${m}, who cannot work in ${task.org ?? "a task without an org"}. Add it to the team if it should help.`,
        );
      }
    }

    const team = members(task, agents);
    const role = team.find((m) => m.id === turn.agent)?.role;
    const settings = await this.deps.config.settings();
    // A turn that changed the worktrees is progress, not a loop: the guard counts from zero again.
    const before = store.tasks.roomState(task.id);
    const fingerprint = await worktreeFingerprint(task);
    const changed = fingerprint !== undefined && fingerprint !== before.fingerprint;
    // This agent was woken by a mention the provider judged: did it act, or only reply with status?
    const acted = changed || (text !== "" && !statusOnly(text));
    this.deps.decisions?.resolve?.(
      "wake",
      `${task.id}\u0000${turn.agent}`,
      acted ? "true" : "false",
      acted ? "the woken agent acted" : "the woken agent only reported status",
    );
    const lead = task.team[0];
    // The lead or a reviewer has seen the worktrees as they are now: only later changes wait for review.
    const seen =
      (turn.agent === lead || role === "Reviewer") && fingerprint !== undefined
        ? { reviewedFingerprint: fingerprint }
        : {};
    const state = {
      ...(changed ? { ...before, agentTurns: 0, fingerprint, nudged: false } : before),
      ...seen,
    };
    // The owner has yet to answer and this turn only waits: nobody else needs to wake for it.
    const waiting = !changed && this.ownerQuestionPending(task.id) && waitsOnly(text);
    // Lead mode: a teammate that addresses the lead after the worktrees changed since the last
    // review hands its work back, whatever its words. The lead reviews and integrates it.
    const handsBack =
      task.mode === "lead" &&
      lead !== undefined &&
      turn.agent !== lead &&
      addresses(text, lead) &&
      unreviewed({
        fingerprint: fingerprint ?? before.fingerprint,
        reviewedFingerprint: before.reviewedFingerprint,
      });
    // A turn that changed nothing wakes only the teammates it asks to act. One that just joined
    // was asked for, so it wakes.
    const named = mentions.filter(
      (m) =>
        m !== OWNER_HANDLE && team.some((t) => t.id === m) && !joined.has(m) && !(handsBack && m === lead),
    );
    const { quiet, told } =
      waiting || named.length === 0 || !routesMentions(task.mode, team, turn.agent)
        ? { quiet: [], told: [] }
        : await this.quietMentions(task.id, turn.agent, text, named, changed);
    if (told.length > 0 || notAdded.length > 0)
      this.tellQuiet(task.id, turn.agent, told, notAdded, answersNote);
    const routed = mentions.filter((m) => !quiet.includes(m));
    const verdict = await this.verdict(task, turn.agent, role, text, routed);
    const plan = planTurn({
      mode: task.mode,
      team,
      from: turn.agent,
      mentions: routed,
      state,
      limits: {
        maxAgentTurns: await this.maxAgentTurns(task),
        reviewRounds: settings.rooms.review_rounds,
      },
      verdict,
      waiting,
    });
    // Read again: the owner may have removed an agent while this turn was being planned.
    const { removed: removedNow } = store.tasks.roomState(task.id);
    store.tasks.setRoomState(task.id, {
      ...plan.state,
      ...(removedNow === undefined ? {} : { removed: removedNow }),
    });

    if (plan.nudge !== undefined) {
      this.say(
        task.id,
        "warn",
        `Agents went in circles without changing files. Woke @${plan.nudge.to} to finish or hand it back.`,
      );
      runs.handoff(task, { from: "majhi", to: plan.nudge.to, via: "guard", text: plan.nudge.text });
      return;
    }
    if (plan.pause !== undefined) {
      // Not awaited: stopping waits for this agent's loop, which is waiting for this call.
      void this.deps.tasks.pauseForOwner(task.id, plan.pause).catch(() => undefined);
      return;
    }
    const handoffs: typeof plan.handoffs = [];
    const refused: string[] = [];
    for (const h of plan.handoffs) {
      if (handedByTool.has(h.to)) continue;
      const account = await this.deps.signedOut?.(h.to);
      if (account === undefined) handoffs.push(h);
      else refused.push(signedOutRefusal(h.to, account));
    }
    for (const h of handoffs) runs.handoff(task, { from: turn.agent, to: h.to, via: h.via, text });
    if (refused.length > 0) {
      for (const line of refused) this.say(task.id, "warn", line);
      // The writer's turn is over, so the room line never reaches it. Once, so it cannot go round.
      if (!answersSignIn) {
        this.signInNoted.add(`${task.id}\u0000${turn.agent}`);
        runs.notify(task.id, turn.agent, refused.join("\n"));
      }
    }
    const handedOn = handoffs.length > 0 || handedByTool.size > 0;
    // Addressed to the owner in plain text: majhi puts the buttons under it.
    // The agent kept working: a question it asked before and nobody answered no longer waits.
    this.movedOn(task.id, turn.agent);
    const busy = this.deps.waitsOnProcess?.(task.id, turn.agent) === true;
    const toOwner = mentions.includes(OWNER_HANDLE) || (!handedOn && text !== "" && asksOwner(text));
    const questioned = !asked && !waiting && !busy && toOwner;
    if (questioned) this.postQuestion(task.id, turn.agent, text);
    if (plan.toOwner !== undefined) {
      this.say(task.id, "info", `${plan.toOwner} Over to you.`);
      return;
    }
    // Lead delegates: in a team, a message nobody else is woken by may still be for the owner.
    if (task.mode === "lead" && !handedOn && task.team.length > 1 && text !== "") {
      const others = runs.working(task.id).filter((a) => a !== turn.agent);
      if (others.length > 0 && !questioned && asksOwner(text)) {
        this.say(task.id, "warn", `@${turn.agent} needs you: ${firstLine(text)}`);
      }
    }
  }

  /**
   * The teammates in `named` that the message only names, without asking them to act: they are
   * not woken. A name in passing ("reported to @x") is quiet by its place alone, unless the words
   * ask. A name that addresses the agent goes by the words (plain status), then the decision
   * provider, and only a sure "no" counts. Unsure, or no provider: none. A turn that changed files
   * wakes the teammates it addresses without asking. `told` are the quiet ones the writer hears
   * about; plain status has its own room line and no note.
   */
  private async quietMentions(
    task: string,
    from: string,
    text: string,
    named: string[],
    changed: boolean,
  ): Promise<{ quiet: string[]; told: string[] }> {
    const names = (agents: readonly string[]) => agents.map((a) => `@${a}`).join(", ");
    // Asked in so many words: woken without asking the provider, so a wrong "no" cannot drop a handoff.
    const asked = named.filter((a) => !asksByWords(text, a));
    const passing = asked.filter((a) => !addresses(text, a));
    const addressed = asked.filter((a) => addresses(text, a));
    const told = (quiet: string[]) => ({ quiet, told: quiet });
    if (asked.length === 0) return { quiet: [], told: [] };
    if (changed) return told(passing);
    if (statusOnly(text)) {
      this.say(task, "info", `@${from} only reported status to ${names(asked)}, so nobody was woken.`);
      return { quiet: asked, told: [] };
    }
    if (addressed.length === 0) return told(passing);
    const decisions = this.deps.decisions;
    if (decisions === undefined) return told(passing);
    const result = await decisions
      .decide(mentionQuestion(from, addressed, text), { use: "routing", task, agent: from })
      .catch(() => undefined);
    if (result === undefined) return told(passing);
    addressed.forEach((agent, i) => {
      decisions.link?.("wake", `${task}\u0000${agent}`, result.id, mentionKey(i));
    });
    const reading = readMentions(addressed, result);
    const quiet = QUIET_ON_NO ? reading.quiet : [];
    const parts = [
      reading.act.length > 0 ? `asks ${names(reading.act)} to act` : "",
      reading.quiet.length > 0 ? `does not ask ${names(reading.quiet)} to act` : "",
      reading.unsure.length > 0 ? `not sure about ${names(reading.unsure)}, so woken` : "",
    ].filter((p) => p !== "");
    decisions.outcome(result.id, {
      text: `Read as: ${parts.join("; ")}.${reading.quiet.length > 0 && !QUIET_ON_NO ? " Woken all the same: a no does not count yet." : ""}`,
      fellBack: reading.unsure.length > 0,
      choices: ["wake", "do not wake"],
    });
    return told([...passing, ...quiet]);
  }

  /**
   * The room lines for mentions that woke nobody or added nobody, and one note for the writer.
   * The writer's turn is over, so the lines never reach it: the note rides with its next prompt
   * and starts no turn. Not for the turn that reads such a note, so a "thanks @x" back cannot go
   * round.
   */
  private tellQuiet(
    task: string,
    from: string,
    quiet: string[],
    notAdded: string[],
    answersNote: boolean,
  ): void {
    const names = (agents: readonly string[]) => agents.map((a) => `@${a}`).join(", ");
    if (quiet.length > 0)
      this.say(
        task,
        "info",
        `@${from} mentioned ${names(quiet)} without asking for anything, so they were not woken.`,
      );
    if (notAdded.length > 0)
      this.say(
        task,
        "info",
        `@${from} named ${names(notAdded)} in passing, so ${notAdded.length === 1 ? "it was" : "they were"} not added to the team.`,
      );
    if (answersNote) return;
    this.quietNoted.add(`${task}\u0000${from}`);
    this.deps.runs.note(
      task,
      from,
      [quiet.length > 0 ? quietNote(quiet) : "", notAdded.length > 0 ? notAddedNote(notAdded) : ""]
        .filter((n) => n !== "")
        .join("\n"),
    );
  }

  /**
   * majhi-room `mention`: hands work to a teammate now, during the caller's turn. Adds the agent
   * when it may join. Counts toward the loop guard, which refuses instead of pausing.
   */
  async mention(caller: { task: string; agent: string }, to: string, text: string): Promise<string> {
    let task = this.deps.store.tasks.get(caller.task);
    if (task === undefined) throw new UserError(`Task ${caller.task} does not exist.`, 404);
    if (task.status === "done") throw new UserError(`${task.id} is done.`, 409);
    if (to === caller.agent) throw new UserError("You cannot hand work to yourself.");
    if (to === OWNER_HANDLE)
      throw new UserError("To reach the owner, say so in your reply and mention @owner.");
    if (this.ownerQuestionPending(task.id) && waitsOnly(text))
      throw new UserError(
        "The owner has a question pending. Waiting needs no handoff: end your turn, and the owner's answer starts the room again.",
        409,
      );
    const account = await this.deps.signedOut?.(to);
    if (account !== undefined) throw new UserError(signedOutRefusal(to, account), 409);
    if (to === (await this.deps.config.sections()).boss) {
      // Never joins the team: the workspace lane hears it, tagged with this task, and answers there.
      const heard = await this.deps.hears?.hear(task, { kind: "agent", id: caller.agent }, text);
      if (heard === undefined || !heard.heard)
        throw new UserError(
          `The captain could not take it now${heard === undefined ? "" : `: ${heard.why}`}.`,
          409,
        );
      return "Sent to the captain. Its answer shows in the task. You can end your turn; it does not join your team.";
    }
    if (!task.team.includes(to)) task = await this.deps.tasks.addToTeam(task.id, to, { by: caller.agent });
    const state = this.deps.store.tasks.roomState(task.id);
    const max = await this.maxAgentTurns(task);
    if (state.agentTurns + 1 > max) {
      throw new UserError(
        `${state.agentTurns} agent turns without the owner. Ask the owner in your reply before handing on.`,
        409,
      );
    }
    this.deps.store.tasks.setRoomState(task.id, { ...state, agentTurns: state.agentTurns + 1 });
    this.deps.runs.handoff(task, { from: caller.agent, to, via: "tool", text });
    const key = `${task.id}\u0000${caller.agent}`;
    this.toolHandoffs.set(key, (this.toolHandoffs.get(key) ?? new Set<string>()).add(to));
    return `Handed to @${to}. It gets your message on its next turn.`;
  }

  /** majhi-room `read_recent`: the last messages, newest first, each trimmed in the middle (5.13). */
  readRecent(task: string, limit: number, beforeSeq: number | undefined): string {
    this.deps.room.flush(task);
    const page = this.deps.store.room.page(task, Math.min(200, limit * 4), beforeSeq);
    const lines: string[] = [];
    let oldest: number | undefined;
    for (const item of page.items) {
      const line = readLine(item);
      if (line === undefined) continue;
      lines.push(`[${item.seq}] ${cutLine(line, item.id)}`);
      oldest = item.seq;
      if (lines.length >= limit) break;
    }
    if (lines.length === 0) return "The room has no messages yet.";
    const more =
      page.more || lines.length >= limit ? `\n\nOlder: call read_recent with before_seq ${oldest}.` : "";
    return `Room of ${task}, newest first:\n${lines.join("\n")}${more}`;
  }

  /** majhi-room `read_recent` with `item`: one message whole, a handoff with the text it carried. */
  readItem(task: string, id: string): string {
    this.deps.room.flush(task);
    const item = this.deps.store.room.get(task, id);
    if (item === undefined) throw new UserError(`The room of ${task} has no item ${id}.`, 404);
    const line =
      item.type === "handoff" ? `@${item.from} handed to @${item.to}:\n${item.text}` : readLine(item);
    if (line === undefined) throw new UserError(`Item ${id} has no message to read.`);
    return `[${item.seq}] ${line}`;
  }

  async postAskCard(
    taskId: string,
    agent: string,
    questions: Array<{
      id: string;
      question: string;
      options: Array<{ id: string; label: string }>;
      default?: string | undefined;
      freeText: boolean;
    }>,
  ): Promise<RoomItem> {
    const task = this.deps.tasks.get(taskId);
    if (!task.team.includes(agent)) {
      throw new UserError(`Agent @${agent} is not on this task.`, 409);
    }
    this.askedInTurn.add(`${task.id}\u0000${agent}`);
    const itemId = `ask:${randomUUID()}`;
    this.deps.room.post(task.id, itemId, {
      type: "ask",
      agent,
      questions,
      state: "pending",
    });
    const item = this.deps.room.get(task.id, itemId);
    if (item === undefined) throw new Error("The ask card was not stored");
    return item;
  }

  /** Reply, and a button per choice read from the message, under an agent's plain-text question. */
  private postQuestion(task: TaskId, agent: string, text: string): void {
    const question = ownerQuestion(text) ?? firstLine(text);
    this.deps.room.post(task, `question:${randomUUID()}`, {
      type: "owner-question",
      agent,
      text: question.slice(0, 600),
      // Merging, shipping and asking for changes live on the review card; no second set of buttons.
      choices: readChoices(text).filter((c) => !REVIEW_CARD_CHOICE.test(c)),
      state: "pending",
    });
  }

  /**
   * Once at startup: unanswered plain-text questions that kept neither the question nor choices
   * (made before cards stored their text) show as an empty Reply and can only mislead. They stop
   * waiting.
   */
  sweepEmptyQuestions(): number {
    let swept = 0;
    for (const t of this.deps.store.tasks.list(false)) {
      for (const q of this.deps.store.room.pendingOfType(t.id, "owner-question")) {
        if (q.type !== "owner-question" || q.choices.length > 0 || (q.text ?? "").trim() !== "") continue;
        this.deps.room.post(t.id as TaskId, q.id, { ...q, state: "moved-on" });
        swept += 1;
      }
    }
    return swept;
  }

  /** This agent's unanswered plain-text questions stop waiting: it went on without an answer. */
  private movedOn(task: TaskId, agent: string): void {
    this.deps.room.flush(task);
    for (const q of this.deps.store.room.pendingOfType(task, "owner-question")) {
      if (q.type !== "owner-question" || q.agent !== agent) continue;
      this.deps.room.post(task, q.id, { ...q, state: "moved-on" });
    }
  }

  /** An ask card or a plain-text question to the owner still waits for an answer. */
  private ownerQuestionPending(task: string): boolean {
    this.deps.room.flush(task);
    const rooms = this.deps.store.room;
    return (
      rooms.pendingOfType(task, "ask").length > 0 || rooms.pendingOfType(task, "owner-question").length > 0
    );
  }

  private async maxAgentTurns(task: Task): Promise<number> {
    const settings = await this.deps.config.settings();
    const org = task.org === undefined ? undefined : (await this.deps.config.sections()).orgs[task.org];
    return org?.rooms?.max_agent_turns ?? settings.rooms.max_agent_turns;
  }

  /**
   * What a reviewer said about the work: in the review loop always, and in lead mode when it woke
   * nobody (so the owner hears that it approved). The words first, then the decision provider.
   */
  private async verdict(
    task: Task,
    agent: string,
    role: Member["role"] | undefined,
    text: string,
    mentions: readonly string[],
  ): Promise<Verdict | undefined> {
    const agents = members(task, await this.frontmatters());
    const isLoopReviewer = task.mode === "review-loop" && loopPair(agents).reviewer === agent;
    if (!isLoopReviewer && !(task.mode === "lead" && role === "Reviewer" && mentions.length === 0))
      return undefined;
    const said = verdictOf(text);
    if (said !== undefined) return said;
    if (!isLoopReviewer) return undefined;
    const answer = await this.deps.decisions
      ?.decide(verdictQuestion(agent, text), { use: "routing", task: task.id, agent })
      .catch(() => undefined);
    const a = answer?.answers.verdict;
    const verdict: Verdict =
      a === undefined || a.gate?.accepted !== true ? "unclear" : a.value === "A" ? "approved" : "changes";
    if (answer !== undefined)
      this.deps.decisions?.outcome(answer.id, {
        text:
          verdict === "unclear"
            ? `Not sure (${a?.gate?.reason ?? "no answer"}), so the room asks the owner.`
            : `Read as ${verdict === "approved" ? "approved" : "changes needed"}.`,
        fellBack: verdict === "unclear",
        choices: ["approved", "changes needed"],
      });
    return verdict;
  }

  private async frontmatters(): Promise<AgentFrontmatter[]> {
    return (await this.deps.agents.list()).flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));
  }

  private say(task: string, level: "info" | "warn", text: string): void {
    this.deps.room.post(task as TaskId, `${level}:${randomUUID()}`, { type: "system", level, text });
  }
}

/**
 * A reviewer's verdict, when its words did not say: two neutral options, described, asked in both
 * orders. On Laya this told approvals from change requests apart at 0.86 to 0.94.
 */
export function verdictQuestion(agent: string, text: string): DecideRequestInput {
  return {
    state: { from: `@${agent}`, message: text.slice(0, STATE_MAX) },
    questions: {
      verdict: {
        type: "choice",
        instructions: "What is the reviewer's verdict in message?",
        options: [
          { key: "A", description: "approves the work as it is, with no more changes asked" },
          { key: "B", description: "asks for changes, finds problems, or is not done reviewing" },
        ],
        abstain: false,
        orders: "reversed",
      },
    },
  };
}

function members(task: Task, agents: readonly AgentFrontmatter[]): Member[] {
  return task.team.map((id) => ({ id, role: agents.find((a) => a.id === id)?.role ?? "Builder" }));
}

/** A long read_recent line cut in the middle, with a marker that says how to read it whole. */
function cutLine(line: string, id: string): string {
  if (line.length <= READ_ITEM_MAX) return line;
  const marker = `\n[... cut; read_recent with item "${id}" reads it whole ...]\n`;
  const head = Math.ceil(READ_ITEM_MAX / 2);
  return `${line.slice(0, head)}${marker}${line.slice(line.length - (READ_ITEM_MAX - head))}`;
}

/** A message in the room for read_recent, or undefined for items that are not conversation. */
export function readLine(item: RoomItem): string | undefined {
  switch (item.type) {
    case "owner":
      return `Owner${item.to === undefined ? "" : ` to @${item.to}`}: ${item.text}`;
    case "agent":
      return item.text.trim() === "" ? undefined : `@${item.agent}: ${item.text}`;
    case "handoff":
      return `@${item.from} handed to @${item.to}`;
    case "diagram":
      return `@${item.agent} drew a diagram: ${item.spec.title}`;
    case "team-plan":
      return `@${item.agent} recorded plan v${item.version}: ${item.steps.map((s, i) => `${i + 1}. ${s.who} ${s.what}`).join(" ")} Why: ${item.why}`;
    case "system":
      return `majhi: ${item.text}`;
    case "approval":
      return `@${item.agent} asked to run ${item.command}: ${item.state}`;
    // A card that still waits for the owner: agents see what holds the task. Settled ones say nothing.
    case "owner-question":
      return item.state === "pending"
        ? `@${item.agent} asked the owner (card waits for an answer): ${item.text ?? ""}`.trimEnd()
        : undefined;
    case "ask":
      return item.state === "pending"
        ? `@${item.agent} asked the owner (card waits for an answer): ${item.questions.map((q) => q.question).join(" | ")}`
        : undefined;
    default:
      return undefined;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? text;
  return line.length > 200 ? `${line.slice(0, 199)}...` : line;
}

/**
 * Each worktree's HEAD and its uncommitted changes, in one string. It changes whenever an agent
 * commits or edits files, which is how the loop guard tells work from talk. Undefined without
 * worktrees or when git cannot be read.
 */
async function worktreeFingerprint(task: Task): Promise<string | undefined> {
  const trees = task.repos.flatMap((r) => (r.worktree === undefined ? [] : [r.worktree]));
  if (trees.length === 0) return undefined;
  try {
    const parts = await Promise.all(
      trees.map(async (t) => {
        const head = (await git(t, ["rev-parse", "HEAD"])).trim();
        const changes = await git(t, ["status", "--porcelain"]);
        return `${head}:${createHash("sha1").update(changes).digest("hex")}`;
      }),
    );
    return parts.join("|");
  } catch {
    return undefined;
  }
}

/** Choices the review card already offers (Ship, Mark done, Ask for changes). */
const REVIEW_CARD_CHOICE =
  /\b(merge|ship|push|mark (it |the task )?done|ask for changes|request changes|review)\b/i;

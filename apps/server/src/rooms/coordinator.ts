import { randomUUID } from "node:crypto";
import {
  type AgentFrontmatter,
  canWorkIn,
  type DecideRequestInput,
  OWNER_HANDLE,
  parseMentions,
  type RoomItem,
  type Task,
  type TaskId,
} from "@majhi/shared";
import { isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import type { Decisions } from "../decisions/api.ts";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import { trimMiddle } from "../runs/handoff.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { asksOwner, loopPair, type Member, planTurn, type Verdict, verdictOf } from "./coordinate.ts";

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
}

/**
 * Teams in a room (SPEC 5.3). When an agent ends a turn, reads the @mentions in its final message,
 * adds mentioned agents that may join, works out who goes next for the task's mode, and hands the
 * work on with a handoff prompt. Stops the room when the loop guard or the review round cap says
 * so. Asks the decision provider only when the words alone do not say what a reviewer decided.
 */
export class RoomCoordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  async turnEnded(turn: { task: string; agent: string; text: string }): Promise<void> {
    const { store, runs } = this.deps;
    let task = store.tasks.get(turn.task);
    if (task === undefined || task.status !== "running" || isBossChat(task)) return;
    const text = turn.text.trim();
    const agents = await this.frontmatters();
    const mentions = parseMentions(
      text,
      agents.map((a) => a.id),
    ).filter((m) => m !== turn.agent);

    // An agent mentioned from outside the team joins when it may work in the org.
    for (const m of mentions) {
      if (m === OWNER_HANDLE || task.team.includes(m)) continue;
      const fm = agents.find((a) => a.id === m);
      if (fm !== undefined && canWorkIn(fm, task.org)) {
        task = await this.deps.tasks.addToTeam(task.id, m, { by: turn.agent });
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
    const verdict = await this.verdict(task, turn.agent, role, text, mentions);
    const settings = await this.deps.config.settings();
    const plan = planTurn({
      mode: task.mode,
      team,
      from: turn.agent,
      mentions,
      state: store.tasks.roomState(task.id),
      limits: {
        maxAgentTurns: await this.maxAgentTurns(task),
        reviewRounds: settings.rooms.review_rounds,
      },
      verdict,
    });
    store.tasks.setRoomState(task.id, plan.state);

    if (plan.pause !== undefined) {
      // Not awaited: stopping waits for this agent's loop, which is waiting for this call.
      void this.deps.tasks.pauseForOwner(task.id, plan.pause).catch(() => undefined);
      return;
    }
    for (const h of plan.handoffs) runs.handoff(task, { from: turn.agent, to: h.to, via: h.via, text });
    if (plan.toOwner !== undefined) {
      this.say(task.id, "info", `${plan.toOwner} Over to you.`);
      return;
    }
    // Lead delegates: in a team, a message nobody else is woken by may still be for the owner.
    if (task.mode === "lead" && plan.handoffs.length === 0 && task.team.length > 1 && text !== "") {
      const others = runs.working(task.id).filter((a) => a !== turn.agent);
      if (others.length > 0 && asksOwner(text)) {
        this.say(task.id, "warn", `@${turn.agent} needs you: ${firstLine(text)}`);
      }
    }
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
      lines.push(`[${item.seq}] ${trimMiddle(line, READ_ITEM_MAX)}`);
      oldest = item.seq;
      if (lines.length >= limit) break;
    }
    if (lines.length === 0) return "The room has no messages yet.";
    const more =
      page.more || lines.length >= limit ? `\n\nOlder: call read_recent with before_seq ${oldest}.` : "";
    return `Room of ${task}, newest first:\n${lines.join("\n")}${more}`;
  }

  async postAskCard(
    taskId: string,
    agent: string,
    questions: Array<{ id: string; question: string; options: Array<{ id: string; label: string }>; default?: string | undefined; freeText: boolean }>,
  ): Promise<RoomItem> {
    const task = this.deps.tasks.get(taskId);
    if (!task.team.includes(agent)) {
      throw new UserError(`Agent @${agent} is not on this task.`, 409);
    }
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

/** A message in the room for read_recent, or undefined for items that are not conversation. */
function readLine(item: RoomItem): string | undefined {
  switch (item.type) {
    case "owner":
      return `Owner${item.to === undefined ? "" : ` to @${item.to}`}: ${item.text}`;
    case "agent":
      return item.text.trim() === "" ? undefined : `@${item.agent}: ${item.text}`;
    case "handoff":
      return `@${item.from} handed to @${item.to}`;
    case "system":
      return `majhi: ${item.text}`;
    case "approval":
      return `@${item.agent} asked to run ${item.command}: ${item.state}`;
    default:
      return undefined;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? text;
  return line.length > 200 ? `${line.slice(0, 199)}...` : line;
}

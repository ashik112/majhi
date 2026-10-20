import {
  type AccountStatus,
  CAPTAIN_LANE_BRIEF,
  type CannotRunReason,
  captainCannotRunId,
  type Job,
  ON_CALL_SUFFIX,
  PRIVATE,
  STOPPED_WHY,
  type Task,
} from "@majhi/shared";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import type { CaptainRepo } from "./repo.ts";
import { providerAllowed } from "./rules.ts";

/**
 * The captain's lanes (SPEC 5.18): the steps of the one captain, one chat per workspace, so one client's code
 * and details are never in a step for another. A lane's task has the workspace's org, so its runs get that
 * workspace's credentials and nothing else. Every lane runs on the captain's one account, or on the workspace's
 * own account when the owner named it ("Captain uses this workspace's account"); an account of another
 * workspace is never used.
 */

export interface LaneDeps {
  repo: CaptainRepo;
  store: Store;
  tasks: Pick<TaskService, "create" | "reopen" | "tellAgent">;
  config: ConfigService;
  agents: AgentStore;
  now: () => Date;
  /** Why the lane rests now: the day budget, the workspace's budget, its account's window. */
  rest?: ((org: string, account: string, job?: Job) => Promise<string | undefined>) | undefined;
  /** Stop everything is on: nothing is told to a lane. */
  halted?: (() => boolean) | undefined;
  /** What an account can do now: its sign-in or limit state and when a limit resets. Absent: every account is fine. */
  accountState?:
    | ((account: string) => Promise<{ status?: AccountStatus | undefined; until?: string | undefined } | undefined>)
    | undefined;
  /** The lane's coming turn is about this task: its lines are tagged with it (the room does it when the lane is idle). */
  about?: ((chat: string, task: string) => void) | undefined;
}

/**
 * The account a lane's turn runs on. `own`: the captain's own account (no account is swapped in). `fallback`:
 * the captain's own is at its limit or signed out and the fallback agent's account runs the turn.
 * Otherwise `why` says in a typed reason that no account may run it.
 */
export type LaneAccount =
  | { account: string; own: boolean; fallback?: true }
  | { problem: string; why: CannotRunReason; until?: string | undefined };

/** A workspace whose captain cannot run, for the one Needs you row. */
export interface CannotRunRow {
  org: string;
  name: string;
  why: CannotRunReason;
  problem: string;
  until?: string | undefined;
}

export class Lanes {
  constructor(private readonly deps: LaneDeps) {}

  /** The captain, when it is set and its agent file is good. */
  async boss(): Promise<string | undefined> {
    const { boss } = await this.deps.config.sections();
    if (boss === undefined) return undefined;
    const stored = await this.deps.agents.get(boss);
    return stored?.ok === true ? boss : undefined;
  }

  /** The workspace whose lane this task is. */
  orgOf(task: string): string | undefined {
    try {
      return this.deps.repo.laneOrg(task);
    } catch {
      // The database closed under a shutdown.
      return undefined;
    }
  }

  /**
   * The lane's chat, when it exists. `reacting` is the on-call lane: urgent work (a client message, an
   * incident) runs there in parallel with a long backlog turn. Same captain, same account and tools.
   */
  chat(org: string, job: Job = "backlog"): string | undefined {
    const id = this.deps.repo.lane(org, job);
    return id !== undefined && this.deps.store.tasks.has(id) ? id : undefined;
  }

  /** Both lanes of a workspace (backlog, then on call) that exist: the chats its one thread is read from. */
  chatsOf(org: string): string[] {
    return (["backlog", "reacting"] as const).flatMap((job) => {
      const chat = this.chat(org, job);
      return chat === undefined ? [] : [chat];
    });
  }

  /** Every lane with a chat that still exists. */
  all(): { org: string; chat: string; job: Job }[] {
    return this.deps.repo.lanes().filter((l) => this.deps.store.tasks.has(l.chat));
  }

  /** The lane's chat, made on first use and reopened when it was closed. A new captain gets a new one. */
  async ensure(org: string, job: Job = "backlog"): Promise<Task> {
    const boss = await this.boss();
    if (boss === undefined)
      throw new UserError("There is no captain yet. Choose one on the Agents page.", 409);
    const sections = await this.deps.config.sections();
    if (org !== PRIVATE && sections.orgs[org] === undefined) {
      throw new UserError(`There is no workspace ${org}.`, 404);
    }
    const id = this.deps.repo.lane(org, job);
    const found = id === undefined ? undefined : this.deps.store.tasks.get(id);
    if (found !== undefined && found.team[0] === boss) {
      return found.status === "done" ? this.deps.tasks.reopen(found.id) : found;
    }
    const made = await this.deps.tasks.create({
      text: CAPTAIN_LANE_BRIEF,
      kind: "chat",
      agent: boss,
      ...(org === PRIVATE ? {} : { org }),
      attachments: [],
      start: false,
      provenance: { kind: "chat" },
      // A lane is a conversation, outside the gate.
      gate: "captain",
    });
    const at = this.deps.now().toISOString();
    // The lane is named for its workspace; the brief stays the marker.
    const name = `Captain: ${sections.orgs[org]?.name ?? "Private"}`;
    this.deps.store.tasks.setText(
      made.id,
      job === "reacting" ? `${name}${ON_CALL_SUFFIX}` : name,
      made.brief,
      at,
    );
    this.deps.repo.setLane(org, made.id, at, job);
    return this.deps.store.tasks.get(made.id) ?? made;
  }

  /**
   * The account the workspace's lane runs on, or why none may (docs/briefs/captain.md). One account runs the captain
   * everywhere: the captain agent's own. A workspace may name its own ("Captain uses this workspace's account"), which
   * must belong to it. At the main account's limit, or signed out, the captain agent's fallback agent's account
   * takes over when it may run here too.
   */
  async account(org: string): Promise<LaneAccount> {
    const sections = await this.deps.config.sections();
    const rules = (await this.deps.config.settings()).autonomy.orgs[org];
    const name = (id: string) => (id === PRIVATE ? "Private" : (sections.orgs[id]?.name ?? id));
    const boss = await this.boss();
    if (boss === undefined) return { problem: "there is no captain", why: "no-captain" };
    const stored = await this.deps.agents.get(boss);
    if (stored === undefined || !stored.ok) {
      return { problem: "the captain's agent file is missing or invalid", why: "no-captain" };
    }
    const own = stored.agent.frontmatter.account;
    const main = rules?.account ?? own;
    const fit = (id: string): Extract<LaneAccount, { problem: string }> | undefined => {
      const account = sections.accounts[id];
      if (account === undefined) return { problem: `the account ${id} is not in majhi.yaml`, why: "no-account" };
      // The workspace's own account must be the workspace's; the captain's account is the owner's, or the workspace's.
      const allowed =
        id === rules?.account ? account.org === org : account.org === PRIVATE || account.org === org;
      if (!allowed) {
        return {
          problem: `${id} belongs to ${name(account.org)}, so it cannot run the captain in ${name(org)}`,
          why: "account-of-another-workspace",
        };
      }
      if (!providerAllowed(rules, account.tool)) {
        return {
          problem: `${account.tool} is not an allowed AI provider in ${name(org)}`,
          why: "provider-not-allowed",
        };
      }
      return undefined;
    };
    const unfit = fit(main);
    if (unfit !== undefined) return unfit;
    const held = await this.held(main);
    if (held === undefined) return { account: main, own: main === own };
    // The main account cannot run: the captain agent's fallback, when it may run here and is free.
    const fallbackAgent = stored.agent.frontmatter.fallback;
    const second = fallbackAgent === undefined ? undefined : await this.deps.agents.get(fallbackAgent);
    const spare = second?.ok === true ? second.agent.frontmatter.account : undefined;
    if (
      spare !== undefined &&
      spare !== main &&
      fit(spare) === undefined &&
      (await this.held(spare)) === undefined
    ) {
      return { account: spare, own: spare === own, fallback: true };
    }
    return {
      problem: `${main} ${held.why}`,
      why: held.reason,
      ...(held.until === undefined ? {} : { until: held.until }),
    };
  }

  /** Why an account cannot run now: signed out, or at its limit with when it resets. Undefined when it can. */
  private async held(
    account: string,
  ): Promise<{ reason: "signed-out" | "at-limit"; why: string; until?: string | undefined } | undefined> {
    const state = await this.deps.accountState?.(account);
    if (state?.status === "needs-login") return { reason: "signed-out", why: "is signed out" };
    if (state?.status === "at-limit") {
      return {
        reason: "at-limit",
        why: "is at its limit",
        ...(state.until === undefined ? {} : { until: state.until }),
      };
    }
    return undefined;
  }

  /**
   * The account a run uses in place of its agent's own: for the captain in a lane, the lane's
   * account. `refuse` when no account may run there. Undefined: the agent's own account.
   */
  async accountFor(task: string, agent: string): Promise<{ account?: string; refuse?: string } | undefined> {
    const org = this.orgOf(task);
    if (org === undefined || agent !== (await this.boss())) return undefined;
    const picked = await this.account(org);
    if ("problem" in picked) return { refuse: `The captain's lane cannot run: ${picked.problem}.` };
    return picked.own ? undefined : { account: picked.account };
  }

  /** Why the lane rests now, or undefined when it may take a turn. */
  async rest(org: string): Promise<string | undefined> {
    const picked = await this.account(org);
    if ("problem" in picked) return picked.problem;
    return this.deps.rest?.(org, picked.account);
  }

  /**
   * A short turn of the captain in the workspace's lane. Not sent when the lane rests (its budget,
   * the day budget or its account's window) or no account may run it.
   */
  async tell(
    org: string,
    text: string,
    settled: string,
    job: Job = "backlog",
    /** The task the wake is about: the captain's words in answer show in that task. */
    about?: string,
  ): Promise<{ sent: true; chat: string } | { sent: false; why: string; decision?: string }> {
    if (this.deps.halted?.() === true) return { sent: false, why: STOPPED_WHY };
    const picked = await this.account(org);
    if ("problem" in picked) {
      return {
        sent: false,
        why: picked.problem,
        // A signed-out account is told by that account's own sign-in decision.
        ...(picked.why === "signed-out" ? {} : { decision: captainCannotRunId(org) }),
      };
    }
    const rest = await this.deps.rest?.(org, picked.account, job);
    if (rest !== undefined) return { sent: false, why: rest };
    try {
      const chat = await this.ensure(org, job);
      const boss = chat.team[0];
      if (boss === undefined) return { sent: false, why: "the lane has no captain" };
      if (about !== undefined) this.deps.about?.(chat.id, about);
      await this.deps.tasks.tellAgent({ task: chat.id, agent: boss, text, settled, by: "majhi" });
      return { sent: true, chat: chat.id };
    } catch (err) {
      return { sent: false, why: errorMessage(err) };
    }
  }

  /**
   * Workspaces whose captain has work (a lane or a client chat it holds) and cannot run, with the typed reason.
   * A signed-out account is told by that account's own sign-in decision, so it is not listed here. Derived from
   * `account` on each call: nothing is stored.
   */
  async cannotRun(): Promise<CannotRunRow[]> {
    const orgs = new Set(this.all().map((l) => l.org));
    for (const room of this.deps.store.client.rooms()) {
      if (room.org !== undefined && room.chat.holder === "captain" && room.chat.archived !== true)
        orgs.add(room.org);
    }
    const sections = await this.deps.config.sections();
    const out: CannotRunRow[] = [];
    for (const org of [...orgs].toSorted()) {
      const picked = await this.account(org);
      if (!("problem" in picked) || picked.why === "signed-out") continue;
      out.push({
        org,
        name: org === PRIVATE ? "Private" : (sections.orgs[org]?.name ?? org),
        why: picked.why,
        problem: picked.problem,
        ...(picked.until === undefined ? {} : { until: picked.until }),
      });
    }
    return out;
  }
}

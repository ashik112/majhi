import {
  CAPTAIN_LANE_BRIEF,
  captainPayDecisionId,
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
 * The captain's lanes (SPEC 5.18): one chat of the one captain per workspace, so one client's code
 * and details are never in its context while it decides for another. A lane's task has the
 * workspace's org, so its runs get that workspace's credentials and nothing else. A client workspace's lane
 * runs on that workspace's own account (the same tool as the captain's), or on the account "More rules" names.
 * The owner's Private account pays for a client workspace only when the owner named it there; an account of
 * another workspace is never used.
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
}

/** `own`: the captain's own account runs the lane, so no account is swapped in. */
export type LaneAccount =
  | { account: string; own: boolean }
  /** `noAccount`: the workspace has no account of its own and the owner has named none: Needs you asks which pays. */
  | { problem: string; noAccount?: true };

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

  /** The account the workspace's lane runs on, or why no account may. */
  async account(org: string): Promise<LaneAccount> {
    const sections = await this.deps.config.sections();
    const rules = (await this.deps.config.settings()).autonomy.orgs[org];
    const name = (id: string) => (id === PRIVATE ? "Private" : (sections.orgs[id]?.name ?? id));
    const boss = await this.boss();
    if (boss === undefined) return { problem: "there is no captain" };
    const stored = await this.deps.agents.get(boss);
    if (stored === undefined || !stored.ok)
      return { problem: "the captain's agent file is missing or invalid" };
    const own = stored.agent.frontmatter.account;
    const ownAccount = sections.accounts[own];
    // A client workspace is paid by its own account. The owner's Private account pays only when the owner picked it
    // for that workspace under More rules: the captain never reaches for it by itself.
    const fallback =
      rules?.account === undefined && org !== PRIVATE && ownAccount !== undefined && ownAccount.org !== org
        ? Object.entries(sections.accounts)
            .filter(([, a]) => a.org === org && a.tool === ownAccount.tool)
            .map(([accountId]) => accountId)
            .toSorted()[0]
        : undefined;
    const id = rules?.account ?? fallback ?? own;
    const account = sections.accounts[id];
    if (account === undefined) return { problem: `the account ${id} is not in majhi.yaml` };
    if (account.org !== org && (account.org !== PRIVATE || rules?.account === undefined)) {
      if (account.org === PRIVATE) {
        return { problem: `${name(org)} has no account for the captain`, noAccount: true };
      }
      return {
        problem: `${id} belongs to ${name(account.org)}, so it cannot pay for ${name(org)}. Pick an account of ${name(org)} in Captain, Permissions, ${name(org)}, Hours, freezes and more`,
      };
    }
    if (!providerAllowed(rules, account.tool)) {
      return { problem: `${account.tool} is not an allowed AI provider in ${name(org)}` };
    }
    return { account: id, own: id === own };
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
  ): Promise<{ sent: true; chat: string } | { sent: false; why: string; decision?: string }> {
    if (this.deps.halted?.() === true) return { sent: false, why: STOPPED_WHY };
    const picked = await this.account(org);
    if ("problem" in picked) {
      return {
        sent: false,
        why: picked.problem,
        ...(picked.noAccount === true ? { decision: captainPayDecisionId(org) } : {}),
      };
    }
    const rest = await this.deps.rest?.(org, picked.account, job);
    if (rest !== undefined) return { sent: false, why: rest };
    try {
      const chat = await this.ensure(org, job);
      const boss = chat.team[0];
      if (boss === undefined) return { sent: false, why: "the lane has no captain" };
      await this.deps.tasks.tellAgent({ task: chat.id, agent: boss, text, settled, by: "majhi" });
      return { sent: true, chat: chat.id };
    } catch (err) {
      return { sent: false, why: errorMessage(err) };
    }
  }

  /**
   * Workspaces whose captain has work (a lane or a client chat it holds) and no account it may use, with the
   * Private accounts the owner could allow to pay. Derived from `account` on each call: nothing is stored.
   */
  async unpaid(): Promise<{ org: string; name: string; choices: string[] }[]> {
    const orgs = new Set(this.all().map((l) => l.org));
    for (const room of this.deps.store.client.rooms()) {
      if (room.org !== undefined && room.chat.holder === "captain" && room.chat.archived !== true)
        orgs.add(room.org);
    }
    const sections = await this.deps.config.sections();
    const autonomy = (await this.deps.config.settings()).autonomy;
    const out: { org: string; name: string; choices: string[] }[] = [];
    for (const org of [...orgs].toSorted()) {
      const picked = org === PRIVATE ? undefined : await this.account(org);
      if (picked === undefined || !("problem" in picked) || picked.noAccount !== true) continue;
      const choices = Object.entries(sections.accounts)
        .filter(([, a]) => a.org === PRIVATE && providerAllowed(autonomy.orgs[org], a.tool))
        .map(([id]) => id)
        .toSorted();
      out.push({ org, name: sections.orgs[org]?.name ?? org, choices });
    }
    return out;
  }
}

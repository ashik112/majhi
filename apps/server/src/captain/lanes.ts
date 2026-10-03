import { CAPTAIN_LANE_BRIEF, PRIVATE, type Task } from "@majhi/shared";
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
 * workspace's org, so its runs get that workspace's credentials and nothing else. A lane runs on the
 * captain's own account unless "More rules" names another account allowed in the workspace; an
 * account of another workspace is never used.
 */

export interface LaneDeps {
  repo: CaptainRepo;
  store: Store;
  tasks: Pick<TaskService, "create" | "reopen" | "tellAgent">;
  config: ConfigService;
  agents: AgentStore;
  now: () => Date;
  /** Why the lane rests now: the day budget, the workspace's budget, its account's window. */
  rest?: ((org: string, account: string) => Promise<string | undefined>) | undefined;
}

export type LaneAccount = { account: string; own: boolean } | { problem: string };

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

  /** The lane's chat, when it exists. */
  chat(org: string): string | undefined {
    const id = this.deps.repo.lane(org);
    return id !== undefined && this.deps.store.tasks.get(id) !== undefined ? id : undefined;
  }

  /** Every lane with a chat that still exists. */
  all(): { org: string; chat: string }[] {
    return this.deps.repo.lanes().filter((l) => this.deps.store.tasks.get(l.chat) !== undefined);
  }

  /** The lane's chat, made on first use and reopened when it was closed. A new captain gets a new one. */
  async ensure(org: string): Promise<Task> {
    const boss = await this.boss();
    if (boss === undefined)
      throw new UserError("There is no captain yet. Choose one on the Agents page.", 409);
    const sections = await this.deps.config.sections();
    if (org !== PRIVATE && sections.orgs[org] === undefined) {
      throw new UserError(`There is no workspace ${org}.`, 404);
    }
    const id = this.deps.repo.lane(org);
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
    });
    const at = this.deps.now().toISOString();
    // The lane is named for its workspace; the brief stays the marker.
    this.deps.store.tasks.setText(
      made.id,
      `Captain: ${sections.orgs[org]?.name ?? "Private"}`,
      made.brief,
      at,
    );
    this.deps.repo.setLane(org, made.id, at);
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
    const id = rules?.account ?? own;
    const account = sections.accounts[id];
    if (account === undefined) return { problem: `the account ${id} is not in majhi.yaml` };
    if (account.org !== org && account.org !== PRIVATE) {
      return {
        problem: `${id} belongs to ${name(account.org)}, so it cannot pay for ${name(org)}. Pick an account of ${name(org)} under More rules`,
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
  ): Promise<{ sent: true; chat: string } | { sent: false; why: string }> {
    const picked = await this.account(org);
    if ("problem" in picked) return { sent: false, why: picked.problem };
    const rest = await this.deps.rest?.(org, picked.account);
    if (rest !== undefined) return { sent: false, why: rest };
    try {
      const chat = await this.ensure(org);
      const boss = chat.team[0];
      if (boss === undefined) return { sent: false, why: "the lane has no captain" };
      await this.deps.tasks.tellAgent({ task: chat.id, agent: boss, text, settled });
      return { sent: true, chat: chat.id };
    } catch (err) {
      return { sent: false, why: errorMessage(err) };
    }
  }
}

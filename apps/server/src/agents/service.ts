import {
  type AccountModels,
  type Agent,
  type AgentEntry,
  AUTO,
  type CommandMeta,
  type HealthCheck,
  type HealthStep,
} from "@majhi/shared";
import type { AccountCache } from "../accounts/cache.ts";
import type { AccountService } from "../accounts/service.ts";
import type { ConfigService } from "../config/service.ts";
import { writeBoss } from "../config/write.ts";
import { UserError } from "../errors.ts";
import type { AgentStore, StoredAgent } from "./store.ts";
import { agentWarnings } from "./warnings.ts";

type Draft = Omit<Agent, "frontmatter"> & { frontmatter: Omit<Agent["frontmatter"], "id"> };

export class AgentService {
  constructor(
    private readonly config: ConfigService,
    private readonly store: AgentStore,
    private readonly cache: AccountCache,
    private readonly accounts: AccountService,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<AgentEntry[]> {
    const [stored, sections] = await Promise.all([
      this.store.list(),
      this.config.sections().catch(() => undefined),
    ]);
    return this.entries(stored, sections);
  }

  async create(id: string, draft: Draft, command: string, meta: CommandMeta): Promise<AgentEntry> {
    if (await this.store.get(id)) throw new UserError(`Agent "${id}" already exists.`, 409);
    await this.write(id, draft, command, meta, `created agent ${id}`);
    return this.entry(id);
  }

  async update(id: string, draft: Draft, command: string, meta: CommandMeta): Promise<AgentEntry> {
    await this.require(id);
    await this.write(id, draft, command, meta, `updated agent ${id}`);
    return this.entry(id);
  }

  async duplicate(id: string, newId: string, command: string, meta: CommandMeta): Promise<AgentEntry> {
    const source = await this.require(id);
    if (!source.ok) {
      throw new UserError(`Agent "${id}" is invalid, so it cannot be copied.`, 409, source.errors);
    }
    if (await this.store.get(newId)) throw new UserError(`Agent "${newId}" already exists.`, 409);
    const { id: _id, ...rest } = source.agent.frontmatter;
    await this.write(
      newId,
      { frontmatter: rest, instructions: source.agent.instructions },
      command,
      meta,
      `copied agent ${id} to ${newId}`,
    );
    return this.entry(newId);
  }

  async remove(id: string, command: string, meta: CommandMeta): Promise<void> {
    await this.require(id);
    const { boss } = await this.config.sections();
    if (boss === id) throw new UserError(`"${id}" is the boss. Make another root agent the boss first.`, 409);
    await this.config.change({ command, meta, summary: `removed agent ${id}` }, () => this.store.remove(id));
  }

  async setBoss(id: string, command: string, meta: CommandMeta): Promise<void> {
    const found = await this.require(id);
    if (!found.ok)
      throw new UserError(`Agent "${id}" is invalid, so it cannot be the boss.`, 409, found.errors);
    if (found.agent.frontmatter.scope !== "root") {
      throw new UserError(
        `Only a root agent can be the boss, and "${id}" works in "${found.agent.frontmatter.scope}".`,
        409,
      );
    }
    const sections = await this.config.sections();
    if (!sections.exists)
      throw new UserError("Pick workspace roots first: majhi.yaml does not exist yet.", 409);
    await this.config.change({ command, meta, summary: `made ${id} the boss` }, () =>
      writeBoss(this.config.file, id),
    );
  }

  /** The account's health plus a `model` step: are the agent's model and effort still offered. */
  async health(id: string): Promise<HealthCheck> {
    const found = await this.require(id);
    if (!found.ok) {
      throw new UserError(`Agent "${id}" is invalid.`, 409, found.errors);
    }
    const f = found.agent.frontmatter;
    const started = this.now();
    const { accounts } = await this.config.sections();
    if (accounts[f.account] === undefined) {
      return this.done(started, [
        { name: "auth", ok: false, detail: `Account "${f.account}" is not in majhi.yaml` },
      ]);
    }
    const { health } = await this.accounts.health(f.account);
    if (!health.ok) return { ...health, durationMs: this.now() - started };
    const { models } = await this.cache.get(f.account);
    return this.done(started, [...health.steps, modelStep(f.model, f.effort, models)]);
  }

  private done(started: number, steps: HealthStep[]): HealthCheck {
    return {
      ok: steps.every((s) => s.ok),
      checkedAt: new Date(this.now()).toISOString(),
      durationMs: this.now() - started,
      steps,
    };
  }

  private write(
    id: string,
    draft: Draft,
    command: string,
    meta: CommandMeta,
    summary: string,
  ): Promise<unknown> {
    const agent: Agent = { frontmatter: { ...draft.frontmatter, id }, instructions: draft.instructions };
    return this.config.change({ command, meta, summary }, () => this.store.write(agent));
  }

  private async require(id: string): Promise<StoredAgent> {
    const found = await this.store.get(id);
    if (found === undefined) throw new UserError(`Agent "${id}" does not exist.`, 404);
    return found;
  }

  private async entry(id: string): Promise<AgentEntry> {
    const found = await this.require(id);
    const [all, sections] = await Promise.all([
      this.store.list(),
      this.config.sections().catch(() => undefined),
    ]);
    const [entry] = await this.entries([found], sections, new Set(all.map((a) => a.id)));
    if (entry === undefined) throw new Error("unreachable");
    return entry;
  }

  private async entries(
    stored: StoredAgent[],
    sections: Awaited<ReturnType<ConfigService["sections"]>> | undefined,
    agentIds: ReadonlySet<string> = new Set(stored.map((a) => a.id)),
  ): Promise<AgentEntry[]> {
    const empty = { exists: false, orgs: {}, accounts: {}, projects: {}, boss: undefined };
    const config = sections ?? empty;
    const models = new Map<string, AccountModels>();
    for (const a of stored) {
      if (!a.ok || models.has(a.agent.frontmatter.account)) continue;
      const cached = (await this.cache.get(a.agent.frontmatter.account)).models;
      if (cached !== undefined) models.set(a.agent.frontmatter.account, cached);
    }
    return stored.map((a): AgentEntry => {
      if (!a.ok) return { status: "invalid", file: a.file, id: a.id, errors: a.errors };
      return {
        status: "ok",
        file: a.file,
        agent: a.agent,
        warnings: agentWarnings(a.agent.frontmatter, { sections: config, models, agentIds }),
        isBoss: config.boss === a.id,
      };
    });
  }
}

function modelStep(
  model: string | undefined,
  effort: string | undefined,
  offered: AccountModels | undefined,
): HealthStep {
  if (offered === undefined) {
    return { name: "model", ok: true, detail: "Not checked: the account did not report its models" };
  }
  const problems: string[] = [];
  if (model !== undefined && model !== AUTO && !offered.models.some((m) => m.id === model)) {
    problems.push(
      `Model "${model}" is not offered. Offered: ${offered.models.map((m) => m.id).join(", ") || "none"}`,
    );
  }
  if (effort !== undefined && effort !== AUTO && !offered.efforts.some((e) => e.id === effort)) {
    problems.push(
      `Effort "${effort}" is not offered. Offered: ${offered.efforts.map((e) => e.id).join(", ") || "none"}`,
    );
  }
  if (problems.length > 0) return { name: "model", ok: false, detail: problems.join(". ") };
  return {
    name: "model",
    ok: true,
    detail: `Model ${model ?? "default"}, effort ${effort ?? "default"} are offered`,
  };
}

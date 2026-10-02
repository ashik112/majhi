import type { CommandInput, CommandMeta } from "@majhi/shared";
import {
  DEFAULT_LEAD_START,
  DEFAULT_MERGE_POLICY,
  LEGACY_PERSONAL,
  type OrgConfig,
  type OrgView,
  PRIVATE,
} from "@majhi/shared";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { renameOrgInConfig, writeOrg } from "../config/write.ts";
import { UserError } from "../errors.ts";
import { orgKeys } from "./keys.ts";

export interface OrgCreate extends OrgConfig {
  id: string;
}

export class OrgService {
  constructor(
    private readonly config: ConfigService,
    private readonly agents: AgentStore,
    /** Moves the tasks of the org in the database. */
    private readonly renameTasks: (id: string, newId: string) => void = () => undefined,
  ) {}

  async list(): Promise<OrgView[]> {
    const { orgs, accounts } = await this.config.sections();
    const agents = await this.agentScopes();
    const keys = orgKeys(orgs);
    return Object.entries(orgs).map(([id, org]) =>
      view(id, org, keys.get(id) ?? "", Object.values(accounts), agents),
    );
  }

  async create(input: OrgCreate, command: string, meta: CommandMeta): Promise<OrgView> {
    const { id, ...org } = input;
    const sections = await this.config.sections();
    if (!sections.exists)
      throw new UserError("Pick workspace roots first: majhi.yaml does not exist yet.", 409);
    if (id === PRIVATE || id === LEGACY_PERSONAL || id === "root") throw new UserError(`"${id}" is reserved`);
    if (sections.orgs[id] !== undefined) throw new UserError(`Org "${id}" already exists.`, 409);
    const config: OrgConfig = { name: org.name };
    if (org.color !== undefined) config.color = org.color;
    if (org.base !== undefined) config.base = org.base;
    if (org.key !== undefined) config.key = org.key;
    await this.config.change({ command, meta, summary: `added org ${id}` }, () =>
      writeOrg(this.config.file, id, config),
    );
    const keys = orgKeys({ ...sections.orgs, [id]: config });
    return view(id, config, keys.get(id) ?? "", [], []);
  }

  /** Changes the fields that are present; `null` removes an optional one. One config commit per call. */
  async update(input: CommandInput<"orgs.update">, command: string, meta: CommandMeta): Promise<OrgView> {
    const { id, ...patch } = input;
    const sections = await this.config.sections();
    const current = sections.orgs[id];
    if (current === undefined) throw new UserError(`Org "${id}" does not exist.`, 404);
    const next: OrgConfig = { ...current };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.color !== undefined) next.color = patch.color;
    for (const field of [
      "base",
      "key",
      "identity",
      "context",
      "resume",
      "commits",
      "rooms",
      "tiers",
      "team",
      "merge",
      "lead_start",
      "mr_tokens",
      "git_accounts",
      "dismissed_logins",
    ] as const) {
      const value = patch[field];
      if (value === null) delete next[field];
      else if (value !== undefined) Object.assign(next, { [field]: value });
    }
    if (next.key !== undefined) {
      const clash = Object.entries(sections.orgs).find(([other, o]) => other !== id && o.key === next.key);
      if (clash) throw new UserError(`The task key ${next.key} is already used by ${clash[1].name}.`, 409);
    }
    const orgs = { ...sections.orgs, [id]: next };
    await this.config.change({ command, meta, summary: `edited org ${id}` }, () =>
      writeOrg(this.config.file, id, next),
    );
    const [agentScopes, accounts] = [await this.agentScopes(), Object.values(sections.accounts)];
    return view(id, next, orgKeys(orgs).get(id) ?? "", accounts, agentScopes);
  }

  /**
   * Changes the org id: `orgs` in majhi.yaml, the org of its accounts and projects, the scope and
   * `where` of agent files, and its tasks. Task keys stay. One config commit.
   */
  async rename(id: string, newId: string, command: string, meta: CommandMeta): Promise<OrgView> {
    const sections = await this.config.sections();
    if (id === PRIVATE)
      throw new UserError("The Private org cannot be renamed. Its name can be changed.", 409);
    if (sections.orgs[id] === undefined) throw new UserError(`Org "${id}" does not exist.`, 404);
    if (id === newId) throw new UserError("That is already its id.");
    if (newId === PRIVATE || newId === LEGACY_PERSONAL || newId === "root")
      throw new UserError(`"${newId}" is reserved`);
    if (sections.orgs[newId] !== undefined) throw new UserError(`Org "${newId}" already exists.`, 409);
    const swap = (v: string) => (v === id ? newId : v);
    const stored = await this.agents.list();
    await this.config.change({ command, meta, summary: `renamed org ${id} to ${newId}` }, async () => {
      await renameOrgInConfig(this.config.file, id, newId);
      for (const a of stored) {
        if (!a.ok) continue;
        const fm = a.agent.frontmatter;
        if (fm.scope !== id && !fm.where.includes(id)) continue;
        await this.agents.write({
          ...a.agent,
          frontmatter: { ...fm, scope: swap(fm.scope), where: fm.where.map(swap) },
        });
      }
      this.renameTasks(id, newId);
    });
    const renamed = (await this.list()).find((o) => o.id === newId);
    if (renamed === undefined) throw new Error("unreachable");
    return renamed;
  }

  private async agentScopes(): Promise<string[]> {
    return (await this.agents.list()).flatMap((a) => (a.ok ? [a.agent.frontmatter.scope] : []));
  }
}

function view(
  id: string,
  org: OrgConfig,
  key: string,
  accounts: readonly { org: string }[],
  agentScopes: readonly string[],
): OrgView {
  const out: OrgView = {
    id,
    name: org.name,
    key,
    accountCount: accounts.filter((a) => a.org === id).length,
    agentCount: agentScopes.filter((s) => s === id).length,
    merge: org.merge ?? DEFAULT_MERGE_POLICY,
    leadStart: org.lead_start ?? DEFAULT_LEAD_START,
  };
  if (org.color !== undefined) out.color = org.color;
  if (org.base !== undefined) out.base = org.base;
  if (org.identity !== undefined) out.identity = org.identity;
  if (org.context?.compact_at !== undefined) out.context = { compact_at: org.context.compact_at };
  if (org.resume?.auto !== undefined) out.resume = { auto: org.resume.auto };
  if (org.commits?.attribution !== undefined) out.commits = { attribution: org.commits.attribution };
  if (org.rooms?.max_agent_turns !== undefined) out.rooms = { max_agent_turns: org.rooms.max_agent_turns };
  if (org.tiers !== undefined && Object.keys(org.tiers).length > 0) out.tiers = org.tiers;
  if (org.team !== undefined && org.team.length > 0) out.team = org.team;
  if (org.mr_tokens !== undefined && Object.keys(org.mr_tokens).length > 0) out.mrTokens = org.mr_tokens;
  if (org.git_accounts !== undefined && org.git_accounts.length > 0) out.gitAccounts = org.git_accounts;
  return out;
}

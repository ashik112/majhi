import type { CommandMeta } from "@majhi/shared";
import { type OrgConfig, type OrgView, PERSONAL } from "@majhi/shared";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { writeOrg } from "../config/write.ts";
import { UserError } from "../errors.ts";

export interface OrgCreate extends OrgConfig {
  id: string;
}

export class OrgService {
  constructor(
    private readonly config: ConfigService,
    private readonly agents: AgentStore,
  ) {}

  async list(): Promise<OrgView[]> {
    const { orgs, accounts } = await this.config.sections();
    const agents = (await this.agents.list()).flatMap((a) => (a.ok ? [a.agent.frontmatter.scope] : []));
    return Object.entries(orgs).map(([id, org]) => view(id, org, Object.values(accounts), agents));
  }

  async create(input: OrgCreate, command: string, meta: CommandMeta): Promise<OrgView> {
    const { id, ...org } = input;
    const sections = await this.config.sections();
    if (!sections.exists)
      throw new UserError("Pick workspace roots first: majhi.yaml does not exist yet.", 409);
    if (id === PERSONAL || id === "root") throw new UserError(`"${id}" is reserved`);
    if (sections.orgs[id] !== undefined) throw new UserError(`Org "${id}" already exists.`, 409);
    const config: OrgConfig = { name: org.name };
    if (org.color !== undefined) config.color = org.color;
    if (org.base !== undefined) config.base = org.base;
    await this.config.change({ command, meta, summary: `added org ${id}` }, () =>
      writeOrg(this.config.file, id, config),
    );
    return view(id, config, [], []);
  }
}

function view(
  id: string,
  org: OrgConfig,
  accounts: readonly { org: string }[],
  agentScopes: readonly string[],
): OrgView {
  const out: OrgView = {
    id,
    name: org.name,
    accountCount: accounts.filter((a) => a.org === id).length,
    agentCount: agentScopes.filter((s) => s === id).length,
  };
  if (org.color !== undefined) out.color = org.color;
  if (org.base !== undefined) out.base = org.base;
  return out;
}

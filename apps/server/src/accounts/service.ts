import { rm } from "node:fs/promises";
import type { RuntimeOptions } from "@majhi/acp";
import {
  type AccountConfig,
  type AccountModels,
  type AccountUsage,
  type AccountView,
  type CommandMeta,
  currentOrgId,
  type HealthCheck,
  PRIVATE,
  type ToolId,
} from "@majhi/shared";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { removeAccountEntry, writeAccount } from "../config/write.ts";
import { UserError } from "../errors.ts";
import type { AcpRuntime } from "../runtime.ts";
import { SECRETS_NOT_SET_UP, type SecretStore } from "../secrets/store.ts";
import type { AccountCache } from "./cache.ts";
import type { AccountProbes } from "./health.ts";
import { accountHome, accountRuntime, secretName } from "./homes.ts";
import { statusFromHealth, statusFromHealthAndUsage } from "./status.ts";
import type { AccountUsageReader } from "./usage.ts";

export interface AccountCreate {
  id: string;
  tool: ToolId;
  org: string;
  auth: "login" | "api-key";
  apiKey?: string | undefined;
}

export interface AccountDeps {
  majhiHome: string;
  config: ConfigService;
  agents: AgentStore;
  secrets: SecretStore;
  cache: AccountCache;
  probes: AccountProbes;
  usage: AccountUsageReader;
  runtime: AcpRuntime;
  options: RuntimeOptions;
  /** Called with the account id before its home is deleted, to end a running login. */
  onRemoving?: (id: string) => void;
  /** An account's status may have changed outside a check, so open screens refetch. */
  onChanged?: () => void;
}

/** First free id of `<tool>-<org>`, `<tool>-<org>-2`, `-3`... Private accounts use `<tool>-private`. */
export function suggestAccountId(tool: ToolId, org: string, taken: ReadonlySet<string>): string {
  const base = `${tool}-${org}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

export class AccountService {
  constructor(private readonly deps: AccountDeps) {}

  async list(): Promise<AccountView[]> {
    const { accounts } = await this.deps.config.sections();
    return Promise.all(Object.entries(accounts).map(([id, config]) => this.view(id, config)));
  }

  async suggestId(tool: ToolId, org: string): Promise<string> {
    const { accounts } = await this.deps.config.sections();
    return suggestAccountId(tool, org, new Set(Object.keys(accounts)));
  }

  async create(raw: AccountCreate, command: string, meta: CommandMeta): Promise<AccountView> {
    const { config, secrets, runtime, majhiHome } = this.deps;
    const input = { ...raw, org: currentOrgId(raw.org) };
    const sections = await config.sections();
    if (!sections.exists)
      throw new UserError("Pick workspace roots first: majhi.yaml does not exist yet.", 409);
    if (sections.orgs[input.org] === undefined) {
      throw new UserError(`Org "${input.org}" does not exist. Create the org first, or use "${PRIVATE}".`);
    }
    if (sections.accounts[input.id] !== undefined) {
      throw new UserError(
        `Account id "${input.id}" is already taken. Try "${suggestAccountId(input.tool, input.org, new Set(Object.keys(sections.accounts)))}".`,
        409,
      );
    }
    const info = runtime.toolInfos().find((t) => t.id === input.tool);
    if (info === undefined) throw new UserError(`Unknown tool "${input.tool}"`);
    if (!info.authModes.includes(input.auth)) {
      throw new UserError(`${info.name} does not support ${input.auth} accounts`);
    }

    const account: AccountConfig = { tool: input.tool, org: input.org, auth: input.auth };
    if (input.auth === "api-key") {
      if (input.apiKey === undefined) throw new UserError("Paste an API key for API-key accounts");
      if (!(await secrets.available())) throw new UserError(SECRETS_NOT_SET_UP, 409);
      account.key = `secret:${input.id}`;
    }

    await runtime.prepareHome(accountRuntime(majhiHome, input.id, account));
    if (account.key !== undefined && input.apiKey !== undefined) {
      await secrets.set(secretName(account.key), input.apiKey);
    }
    try {
      await config.change(
        { command, meta, summary: `added account ${input.id} (${describe(account)})` },
        () => writeAccount(config.file, input.id, account),
      );
    } catch (err) {
      if (account.key !== undefined) await secrets.delete(secretName(account.key));
      throw err;
    }
    return this.view(input.id, account);
  }

  async remove(id: string, command: string, meta: CommandMeta): Promise<void> {
    const { config, agents, secrets, cache, majhiHome } = this.deps;
    const { accounts } = await config.sections();
    const account = accounts[id];
    if (account === undefined) throw new UserError(`Account "${id}" does not exist.`, 404);
    const users = await agents.usersOf(id);
    if (users.length > 0) {
      throw new UserError(`Agents still use ${id}. Move or remove them first.`, 409, users);
    }
    this.deps.onRemoving?.(id);
    await config.change({ command, meta, summary: `removed account ${id}` }, () =>
      removeAccountEntry(config.file, id),
    );
    await rm(accountHome(majhiHome, id), { recursive: true, force: true });
    if (account.key !== undefined) await secrets.delete(secretName(account.key));
    await cache.remove(id);
  }

  /** Hides a model from `auto` picks, or shows it again. The list stays in the order it was hidden. */
  async hideModel(
    id: string,
    model: string,
    hidden: boolean,
    command: string,
    meta: CommandMeta,
  ): Promise<AccountView> {
    const config = await this.require(id);
    const current = config.hidden_models ?? [];
    if (current.includes(model) === hidden) return this.view(id, config);
    const list = hidden ? [...current, model] : current.filter((m) => m !== model);
    const { hidden_models: _old, ...rest } = config;
    const next: AccountConfig = list.length === 0 ? rest : { ...rest, hidden_models: list };
    await this.deps.config.change(
      { command, meta, summary: `${hidden ? "hid" : "showed"} ${model} on account ${id}` },
      () => writeAccount(this.deps.config.file, id, next),
    );
    return this.view(id, next);
  }

  async health(id: string, force = false): Promise<{ account: AccountView; health: HealthCheck }> {
    const config = await this.require(id);
    const health = await this.deps.probes.check(id, config, force);
    return { account: await this.view(id, config), health };
  }

  async models(id: string, refresh: boolean): Promise<AccountModels> {
    return this.deps.probes.models(id, await this.require(id), refresh);
  }

  /** The model list the last probe cached, without probing the account. Undefined when there is none. */
  async cachedModels(id: string): Promise<AccountModels | undefined> {
    return (await this.deps.probes.cached(id)).models;
  }

  /** The account's usage windows, or null for API-key accounts. Reads when there is none cached or `refresh` is set. */
  async usage(id: string, refresh: boolean): Promise<AccountUsage | null> {
    return this.deps.usage.get(id, await this.require(id), refresh);
  }

  /** Login accounts whose last check passed: the ones the background sweep reads. */
  async usageCandidates(): Promise<{ id: string; config: AccountConfig }[]> {
    const { accounts } = await this.deps.config.sections();
    const found = await Promise.all(
      Object.entries(accounts).map(async ([id, config]) => {
        if (config.auth !== "login") return undefined;
        return (await this.deps.probes.cached(id)).health?.ok === true ? { id, config } : undefined;
      }),
    );
    return found.filter((c) => c !== undefined);
  }

  /**
   * A run failed on the account's sign-in: it is `needs-login` now, until a check confirms the
   * sign-in works again. True when it was not `needs-login` before.
   */
  async markSignedOut(id: string, detail: string): Promise<boolean> {
    const fresh = await this.deps.cache.markSignedOut(id, detail, new Date());
    this.deps.onChanged?.();
    return fresh;
  }

  /** Whether the account is known to need a new sign-in. From the last check, never a probe. */
  async needsLogin(id: string): Promise<boolean> {
    return statusFromHealth((await this.deps.probes.cached(id)).health) === "needs-login";
  }

  /** The agent's account when that account needs a new sign-in, else undefined. */
  async signedOutAccountOf(agent: string): Promise<string | undefined> {
    const stored = await this.deps.agents.get(agent).catch(() => undefined);
    const account =
      stored === undefined ? undefined : stored.ok ? stored.agent.frontmatter.account : stored.account;
    if (account === undefined) return undefined;
    return (await this.needsLogin(account)) ? account : undefined;
  }

  async require(id: string): Promise<AccountConfig> {
    const { accounts } = await this.deps.config.sections();
    const account = accounts[id];
    if (account === undefined) throw new UserError(`Account "${id}" does not exist.`, 404);
    return account;
  }

  private async view(id: string, config: AccountConfig): Promise<AccountView> {
    const [cached, users] = await Promise.all([this.deps.probes.cached(id), this.deps.agents.usersOf(id)]);
    const view: AccountView = {
      id,
      tool: config.tool,
      org: config.org,
      auth: config.auth,
      home: accountHome(this.deps.majhiHome, id),
      hiddenModels: config.hidden_models ?? [],
      agentCount: users.length,
      status: statusFromHealthAndUsage(cached.health, cached.usage),
    };
    if (cached.signedInAs !== undefined) view.signedInAs = cached.signedInAs;
    if (cached.health !== undefined) view.lastHealth = cached.health;
    if (cached.usage !== undefined) view.usage = cached.usage;
    return view;
  }
}

function describe(account: AccountConfig): string {
  return `${account.tool}, ${account.org}, ${account.auth}`;
}

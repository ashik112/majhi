import { type ConnectionConfig, detectSecrets, type GitAccount, PRIVATE } from "@majhi/shared";

/**
 * The hard limits of autonomous mode (PRV-74, rule 5): what the boss and the agents of autonomous
 * tasks never do, whatever a policy, a saved rule or an `auto` mode says. Pure: the service gathers
 * the world, and every refusal is one line the agent and the owner read.
 *
 * - No force push: a merge never pushes, and a push never deletes the worktree after it.
 * - No removing a task over uncommitted work.
 * - No passing one org's credentials to another: secrets, accounts, `where`, git accounts and
 *   logins, SSH aliases and connections stay with the org that has them. `private` is an org.
 * - No secrets in text, and no raw secret values at all: only `secret:<name>` references.
 */

/** What the limits know of majhi's orgs, accounts and agents. */
export interface LimitWorld {
  /** The org the call acts in (`callOrg`), `private` for none. */
  org: string;
  /** Every org's credentials and connections, `private` included. */
  orgs: Readonly<Record<string, OrgCredentials>>;
  accounts: Readonly<Record<string, { org: string; key?: string | undefined }>>;
  agents: Readonly<Record<string, LimitAgent>>;
  /** The Mac's git logins per host (`git.logins`): whose a gh or glab login is. */
  logins: readonly { host: string; via: string; account: string; alias?: string | undefined }[];
}

export interface OrgCredentials {
  mr_tokens?: Readonly<Record<string, string | undefined>> | undefined;
  git_accounts?: readonly GitAccount[] | undefined;
  connections?: Readonly<Record<string, ConnectionConfig>> | undefined;
}

export interface LimitAgent {
  scope: string;
  account: string;
  where: readonly string[];
  connections: readonly string[];
}

export interface LimitCall {
  command: string;
  /** The input as the caller sent it, before defaults. */
  input: Record<string, unknown>;
  /** The caller's one-line reason: it goes into the feed, so it is text too. */
  reason?: string | undefined;
}

/** Why the call may not run at all, or undefined. */
export function hardLimit(call: LimitCall, world: LimitWorld): string | undefined {
  return textLimit(call) ?? crossOrg(call, world);
}

/**
 * The limits that need nothing but the call: secrets, force pushes and worktrees. Enough for a read,
 * which passes nothing from one org to another.
 */
export function textLimit(call: LimitCall): string | undefined {
  return rawSecret(call) ?? secretText(call) ?? noForce(call);
}

// ---------------------------------------------------------------------------
// Secrets

/**
 * Inputs that carry a secret's value. An agent that has the value had it in its chat. A connection's
 * file (a kubeconfig, a key) has no `secret:` form at all: only the owner sets one, from the page.
 */
const RAW_SECRET_FIELDS: Readonly<Record<string, string>> = {
  "connections.setSecret": "value",
  "connections.setFile": "upload",
  "secrets.save": "value",
  "accounts.create": "apiKey",
  "orgs.setGitAccount": "token",
};

function rawSecret({ command, input }: LimitCall): string | undefined {
  const field = RAW_SECRET_FIELDS[command];
  if (field === undefined || input[field] === undefined) return undefined;
  if (command === "connections.setFile") {
    return "Refused: autonomous mode never sets a connection's file. Only the owner does, from the connection's page.";
  }
  return `Refused: autonomous mode never passes a secret's value (${field}). Ask the owner with majhi_request_secret and pass the secret:<name> it gives back.`;
}

/** Every string in a value, with where it sits, like `children.0.text`. */
export function stringsOf(value: unknown, path = ""): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path: path || "input", text: value }];
  if (Array.isArray(value))
    return value.flatMap((v, i) => stringsOf(v, path === "" ? String(i) : `${path}.${i}`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => stringsOf(v, path === "" ? k : `${path}.${k}`));
  }
  return [];
}

/** Every key of every object in a value, with where it sits. */
function keysOf(value: unknown, path = ""): { path: string; text: string }[] {
  if (Array.isArray(value))
    return value.flatMap((v, i) => keysOf(v, path === "" ? String(i) : `${path}.${i}`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const at = path === "" ? k : `${path}.${k}`;
    return [{ path: `a key in ${path === "" ? "the input" : path}`, text: k }, ...keysOf(v, at)];
  });
}

function secretText({ input, reason }: LimitCall): string | undefined {
  const texts = [
    ...stringsOf(input),
    ...keysOf(input),
    ...(reason === undefined ? [] : [{ path: "reason", text: reason }]),
  ];
  const found = texts.find((t) => detectSecrets(t.text).length > 0);
  if (found === undefined) return undefined;
  return `Refused: ${found.path} holds what looks like a secret. Never put secrets in text: ask the owner with majhi_request_secret and use the secret:<name> it gives back.`;
}

const SECRET_REF = /secret:[a-z0-9][a-z0-9-]{0,62}/g;

/** The `secret:` references in a value's strings. */
function refsIn(value: unknown): string[] {
  return [...new Set(stringsOf(value).flatMap((t) => t.text.match(SECRET_REF) ?? []))];
}

/** The secret references a connection holds: secret fields, and secret vars, headers and env. */
function connectionRefs(conn: ConnectionConfig): string[] {
  return refsIn([conn.fields ?? {}, conn.vars ?? {}, conn.headers ?? {}, conn.env ?? {}]);
}

/** The orgs whose config or accounts reference this secret. */
export function ownersOf(ref: string, world: Pick<LimitWorld, "orgs" | "accounts">): string[] {
  const owners = new Set<string>();
  for (const [org, c] of Object.entries(world.orgs)) {
    if (Object.values(c.mr_tokens ?? {}).includes(ref)) owners.add(org);
    if ((c.git_accounts ?? []).some((a) => a.token === ref)) owners.add(org);
    if (Object.values(c.connections ?? {}).some((conn) => connectionRefs(conn).includes(ref)))
      owners.add(org);
  }
  for (const a of Object.values(world.accounts)) if (a.key === ref) owners.add(a.org);
  return [...owners];
}

// ---------------------------------------------------------------------------
// Pushes and worktrees

function noForce({ command, input }: LimitCall): string | undefined {
  const mergePush =
    (command === "tasks.merge" && input.push !== undefined && input.push !== false) ||
    ((command === "room.cardAction" || command === "tasks.resolveShip") && input.action === "mergePush");
  if (mergePush) {
    return "Refused: autonomous mode never pushes with a merge. Merge without push, and push with tasks.push, which never forces.";
  }
  if (input.deleteAfter === true) {
    return "Refused: autonomous mode never deletes a worktree after a ship. Ship without deleteAfter; the owner cleans up.";
  }
  if (command === "tasks.markMerged" && input.force === true) {
    return "Refused: autonomous mode never marks a merge request merged without its host's word. Leave force to the owner.";
  }
  if (command === "tasks.remove" && (input.force !== undefined || input.confirm !== undefined)) {
    return "Refused: autonomous mode never removes a task over uncommitted work.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Orgs

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function list(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** The org that owns a connection, or undefined when there is no such connection. */
export function connectionOwner(id: string, orgs: LimitWorld["orgs"]): string | undefined {
  return Object.entries(orgs).find(([, c]) => c.connections?.[id] !== undefined)?.[0];
}

/** The org other than `except` that has this git account on this host. */
function gitAccountOwner(
  orgs: LimitWorld["orgs"],
  host: string,
  account: string,
  except: string,
): string | undefined {
  const h = host.toLowerCase();
  const a = account.toLowerCase();
  return Object.entries(orgs).find(
    ([org, c]) =>
      org !== except &&
      (c.git_accounts ?? []).some((g) => g.host.toLowerCase() === h && g.account.toLowerCase() === a),
  )?.[0];
}

/** The org other than `except` whose git account pushes through this SSH alias. */
function sshOwner(orgs: LimitWorld["orgs"], alias: string, except: string): string | undefined {
  return Object.entries(orgs).find(
    ([org, c]) => org !== except && (c.git_accounts ?? []).some((g) => g.ssh === alias),
  )?.[0];
}

function crossOrg(call: LimitCall, world: LimitWorld): string | undefined {
  return (
    secretRefs(call, world) ??
    agentLimits(call, world) ??
    gitLimits(call, world) ??
    connectionLimits(call, world)
  );
}

/**
 * A `secret:` reference that another org's config or accounts use is refused. The tokens of git
 * accounts and MR tokens must be ones the org already has: a secret no org references is refused.
 */
function secretRefs({ command, input }: LimitCall, world: LimitWorld): string | undefined {
  for (const ref of refsIn(input)) {
    const other = ownersOf(ref, world).find((o) => o !== world.org);
    if (other !== undefined) return `Refused: ${ref} belongs to ${other}, so ${world.org} cannot use it.`;
  }
  if (command !== "orgs.update") return undefined;
  const tokens = [
    ...refsIn(input.mr_tokens ?? {}),
    ...refsIn((list(input.git_accounts) ?? []).map((a) => record(a)?.token)),
  ];
  for (const ref of tokens) {
    if (!ownersOf(ref, world).includes(world.org)) {
      return `Refused: ${ref} is not a token ${world.org} already has. Only the owner gives an org a new token.`;
    }
  }
  return undefined;
}

/** An org agent keeps to its org: its own org's account, `where` and connections. Root agents are the owner's. */
function checkOrgAgent(
  scope: string,
  fields: { account?: unknown; where?: unknown; connections?: unknown },
  world: LimitWorld,
  explicitWhere: boolean,
): string | undefined {
  if (scope === "root") return undefined;
  const account = str(fields.account);
  const accountOrg = account === undefined ? undefined : world.accounts[account]?.org;
  if (account !== undefined && accountOrg !== undefined && accountOrg !== scope) {
    return `Refused: the account ${account} belongs to ${accountOrg}, so an agent of ${scope} cannot use it.`;
  }
  for (const w of list(fields.where) ?? []) {
    if (w === scope) continue;
    // An org agent's default `anywhere` keeps it in its own org; asking for it on purpose is refused.
    if (w === "anywhere" && !explicitWhere) continue;
    return `Refused: an agent of ${scope} works only in ${scope}, not in ${String(w)}.`;
  }
  for (const id of list(fields.connections) ?? []) {
    const owner = typeof id === "string" ? connectionOwner(id, world.orgs) : undefined;
    if (owner !== undefined && owner !== scope) {
      return `Refused: the connection ${String(id)} belongs to ${owner}, so an agent of ${scope} cannot have it.`;
    }
  }
  return undefined;
}

/**
 * A root agent may work in any org, and takes its account into every task it works in. On an org's
 * account (not `private`), its `where` must be that org alone, so the decision provider never picks
 * it for another org's task. `where` left out means `anywhere`.
 */
function checkRootAgent(account: unknown, where: unknown, world: LimitWorld): string | undefined {
  const id = str(account);
  const org = id === undefined ? undefined : world.accounts[id]?.org;
  if (org === undefined || org === PRIVATE) return undefined;
  const places = list(where) ?? ["anywhere"];
  if (places.length > 0 && places.every((w) => w === org)) return undefined;
  return `Refused: a root agent on ${org}'s account ${id} works only in ${org}. Give it where: [${org}].`;
}

function agentLimits({ command, input }: LimitCall, world: LimitWorld): string | undefined {
  if (command === "agents.create" || command === "agents.update") {
    const fm = record(input.frontmatter);
    const scope = str(fm?.scope);
    if (fm === undefined || scope === undefined) return undefined;
    return scope === "root"
      ? checkRootAgent(fm.account, fm.where, world)
      : checkOrgAgent(scope, fm, world, true);
  }
  const id = str(input.id);
  const agent = id === undefined ? undefined : world.agents[id];
  if (agent === undefined) return undefined;
  if (command === "agents.edit") {
    const set = record(input.set) ?? {};
    if (agent.scope !== "root") return checkOrgAgent(agent.scope, set, world, true);
    // Only an edit of the account or `where` is checked: other edits leave the owner's setup alone.
    if (set.account === undefined && set.where === undefined) return undefined;
    return checkRootAgent(set.account ?? agent.account, set.where ?? agent.where, world);
  }
  if (command === "agents.duplicate") {
    return agent.scope === "root"
      ? checkRootAgent(agent.account, agent.where, world)
      : checkOrgAgent(agent.scope, agent, world, false);
  }
  return undefined;
}

function gitLimits({ command, input }: LimitCall, world: LimitWorld): string | undefined {
  const org = str(input.id);
  if (org === undefined) return undefined;
  const entries: { host?: unknown; account?: unknown; ssh?: unknown }[] =
    command === "orgs.setGitAccount" || command === "orgs.useSavedLogin"
      ? [input]
      : command === "orgs.update"
        ? (list(input.git_accounts) ?? []).flatMap((a) => {
            const entry = record(a);
            return entry === undefined ? [] : [entry];
          })
        : [];
  for (const e of entries) {
    const host = str(e.host);
    const account = str(e.account);
    const owner =
      host === undefined || account === undefined
        ? undefined
        : gitAccountOwner(world.orgs, host, account, org);
    if (owner !== undefined)
      return `Refused: ${account} on ${host} is a git account of ${owner}, not of ${org}.`;
    const alias = str(e.ssh);
    const aliasOwner = alias === undefined ? undefined : sshOwner(world.orgs, alias, org);
    if (aliasOwner !== undefined)
      return `Refused: the SSH alias ${alias} pushes for ${aliasOwner}, not for ${org}.`;
  }
  if (command === "orgs.useGitLogin") {
    const host = str(input.host)?.toLowerCase();
    const via = str(input.via);
    const accounts = world.logins.filter((l) => l.host === host && l.via === via).map((l) => l.account);
    if (accounts.length === 0) {
      return `Refused: majhi cannot tell whose ${via ?? "git"} login on ${host ?? "that host"} this is, so only the owner can give it to ${org}.`;
    }
    for (const account of accounts) {
      const owner = host === undefined ? undefined : gitAccountOwner(world.orgs, host, account, org);
      if (owner !== undefined)
        return `Refused: the ${via} login on ${host} is ${account}, a git account of ${owner}.`;
    }
  }
  return undefined;
}

/** The agents a call puts on a task's team. */
function joiningAgents(command: string, input: Record<string, unknown>): string[] {
  const named: unknown[] = [];
  if (command === "tasks.create") named.push(input.agent, ...(list(input.team) ?? []));
  if (command === "tasks.split") named.push(...(list(input.children) ?? []).map((c) => record(c)?.agent));
  if (command === "team.add" || command === "tasks.addAgent" || command === "tasks.update")
    named.push(input.agent);
  if (command === "team.swap") named.push(input.with);
  return named.flatMap((a) => (typeof a === "string" ? [a] : []));
}

/**
 * Another org's connection is never named on a task, and an agent never brings another org's
 * account into one: an agent's account goes into every task it works in. `private` accounts are the
 * owner's own and may work anywhere their agent may.
 */
function connectionLimits({ command, input }: LimitCall, world: LimitWorld): string | undefined {
  if (command === "tasks.create") {
    for (const id of list(input.connections) ?? []) {
      const owner = typeof id === "string" ? connectionOwner(id, world.orgs) : undefined;
      if (owner !== undefined && owner !== world.org) {
        return `Refused: the connection ${String(id)} belongs to ${owner}, so a task of ${world.org} cannot have it.`;
      }
    }
  }
  for (const agent of joiningAgents(command, input)) {
    const account = world.agents[agent]?.account;
    const org = account === undefined ? undefined : world.accounts[account]?.org;
    if (org !== undefined && org !== PRIVATE && org !== world.org) {
      return `Refused: @${agent} works on ${org}'s account ${account}, so it cannot work in a task of ${world.org}.`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Which org a call acts in

/** How the limits find the orgs of what a call names. Undefined: there is no such thing. */
export interface OrgLookup {
  /** A task's org, `null` for a task with none. */
  task(id: string): string | null | undefined;
  project(id: string): string | undefined;
  connection(id: string): string | undefined;
}

/**
 * The org a call acts in: the org it names, the org of the task, project or connection it names,
 * else `fallback` (the caller's task's org). `private` stands for none.
 */
export function callOrg(
  command: string,
  input: Record<string, unknown>,
  look: OrgLookup,
  fallback: string,
): string {
  const group = command.split(".", 1)[0];
  const id = str(input.id);
  if (group === "orgs") return id ?? fallback;
  if (command === "connections.create" || command === "accounts.create" || command === "projects.register") {
    return str(input.org) ?? fallback;
  }
  if (group === "connections") return (id === undefined ? undefined : look.connection(id)) ?? fallback;
  if (command === "agents.create" || command === "agents.update") {
    const scope = str(record(input.frontmatter)?.scope);
    return scope === undefined || scope === "root" ? fallback : scope;
  }
  if (command === "tasks.create") {
    for (const repo of list(input.repos) ?? []) {
      const project = str(record(repo)?.project);
      const org = project === undefined ? undefined : look.project(project);
      if (org !== undefined) return org;
    }
    const parent = str(input.parent) ?? str(input.followUpOf);
    const parentOrg = parent === undefined ? undefined : look.task(parent);
    if (parentOrg !== undefined) return parentOrg ?? PRIVATE;
    // A task with no repos and no parent has no org, whoever makes it.
    return PRIVATE;
  }
  const task = str(input.task) ?? (group === "tasks" ? id : undefined);
  if (task !== undefined) {
    const org = look.task(task);
    if (org !== undefined) return org ?? PRIVATE;
  }
  return fallback;
}

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  type CommandMeta,
  type ConnectAccess,
  type ConnectCatalog,
  type ConnectFlowState,
  type ConnectFlowView,
  type ConnectionConfig,
  type ConnectionFailure,
  type ConnectionTestResult,
  type ConnectionType,
  type ConnectScopeLine,
  type ConnectStartInput,
  type ConnectState,
  type ConnectStatus,
  cliTool,
  failureFromError,
  failureFromHttp,
  SERVICE_CATALOG,
  type ServiceEntry,
  type ServiceProduct,
  type ServiceProvider,
  scopesAt,
  serviceById,
  serviceByUrl,
  suggestConnectionId,
  textValue,
} from "@majhi/shared";
import { annotationsOf, type ListedTool } from "../connections/mcp-client.ts";
import { UserError } from "../errors.ts";
import type { AppClientStore } from "./app-client.ts";
import { AppService } from "./app-service.ts";
import type { CliHost } from "./cli-connect.ts";
import type { Grant, GrantStore } from "./grant.ts";
import {
  authorizationUrl,
  type ClientIdentity,
  ConnectError,
  type Discovered,
  discover,
  exchange,
  type Fetch,
  hostOf,
  identify,
  probeToken,
  refresh,
  refusalReason,
  register,
  revocationEndpointOf,
  revoke,
  type TokenProbe,
  type TokenSet,
} from "./oauth.ts";
import {
  type ApiProbe,
  authorizationPage,
  exchangeCode,
  joinScope,
  type ProviderClient,
  pkce,
  pollDevice,
  probeProvider,
  refreshTokens,
  startDevice,
} from "./provider-oauth.ts";
import { bareHost, guardedFetch } from "./self-host.ts";
import { checkToken } from "./token-check.ts";

/** How long the browser page works. The owner has this long to approve. */
export const FLOW_TTL_MS = 10 * 60_000;
/** A command-line tool's own sign-in may wait this long: device codes last 15 minutes. */
const CLI_FLOW_TTL_MS = 15 * 60_000;
/** An ended attempt stays readable this long, so a screen can show how it ended. */
const ENDED_KEEP_MS = 30 * 60_000;
/** An access token with less than this left is renewed before it is used. */
export const REFRESH_SKEW_MS = 5 * 60_000;
/** The background pass renews tokens of connections in use this long before they end. */
const SWEEP_AHEAD_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;
/** A sign-in with no renewal gets a reminder this long before it ends. */
const REMIND_AHEAD_MS = 5 * 24 * 60 * 60_000;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** The slice of the connections service that Connect needs. */
export interface ConnectConnections {
  create(
    input: {
      org: string;
      id?: string;
      type: ConnectionType;
      name: string;
      description?: string;
      fields: Record<string, string>;
      vars?: Record<string, { kind: "secret" | "text"; value?: string }>;
    },
    command: string,
    meta: CommandMeta,
  ): Promise<unknown>;
  remove(id: string, command: string, meta: CommandMeta): Promise<unknown>;
  /** Stores a secret value of a connection's list entry in secrets.age. */
  setSecret?(
    input: { id: string; field: string; list: "vars"; value: string },
    command: string,
    meta: CommandMeta,
  ): Promise<unknown>;
  find(id: string): Promise<{ org: string; connection: ConnectionConfig } | undefined>;
}

export interface ConnectDeps {
  grants: GrantStore;
  connections: ConnectConnections;
  /** Every connection id of every org, to pick a free one. */
  connectionIds: () => Promise<{ org: string; id: string; connection: ConnectionConfig }[]>;
  orgExists: (org: string) => Promise<boolean>;
  /** `<origin>/oauth/callback`: where the service sends the owner back. */
  redirect: string;
  /** Majhi's published client metadata document, when one is configured. */
  clientMetadataUrl?: string | undefined;
  /** Asks the host helper to open the page. False when it is offline or could not. */
  openUrl: (url: string) => Promise<boolean>;
  helperConnected: () => boolean;
  fetch?: Fetch;
  now?: () => Date;
  catalog?: readonly ServiceEntry[];
  /** Tells the screens. */
  changed: () => void;
  /** DNS lookup of the host guard for servers added by address. Tests give a fake. */
  lookup?: ((name: string) => Promise<string[]>) | undefined;
  /** Where a connection stands: a connect starts it, a check ends it, a refused renewal fails it. */
  health?:
    | {
        start(id: string): unknown;
        observe(id: string, result: ConnectionTestResult): unknown;
        failed(id: string, failure: ConnectionFailure): unknown;
        remove(id: string): unknown;
      }
    | undefined;
  /** Lists the tools of the server with a bearer token. Throws with a sentence when it cannot. */
  listTools: (url: string, token: string) => Promise<ListedTool[]>;
  /** True while a session holds the connection, so its token is renewed ahead of time. */
  inUse?: (connection: string) => boolean;
  /** Restarts the sessions that hold the connection at their next turn end. */
  remount?: (connection: string) => void;
  /** Hands the owner something to do, once per key: a finding in the workspace. */
  attention?: (item: { org: string; key: string; title: string; detail: string }) => void;
  /** One line per event, never with a value. */
  log?: (line: string) => void;
  /** The owner's apps, per workspace (guided setup). */
  apps: AppClientStore;
  /** Public client IDs majhi ships, by app. */
  builtInApps?: Readonly<Record<string, string>>;
  /** Telegram's Bot API address, when it is not Telegram's own (a trial against a fake bot server). */
  telegramApi?: string | undefined;
  /** The client ID of the workspace-wide GitHub OAuth app git sign-in already uses, if any. */
  githubClientId?: () => Promise<string | undefined>;
  /** Command-line tool sign-ins through the host helper. */
  cli?: CliHost;
  /** The name of a workspace, for the app's name in the provider's list. Undefined when there is none. */
  orgName: (org: string) => Promise<string | undefined>;
  /** The value of a secret entry of a connection's `vars`. */
  secretOf: (connection: string, name: string) => Promise<string | undefined>;
  /** Waits between device polls. Tests replace it. */
  wait?: (ms: number) => Promise<void>;
}

interface Pending {
  /** The `state` parameter the service must send back. */
  state: string;
  verifier: string | undefined;
  /** An MCP server's discovered sign-in. Absent for a provider's own OAuth. */
  found: Discovered | undefined;
  client: ClientIdentity;
  scope: string | undefined;
  /** The provider's own OAuth. */
  provider: { config: ServiceProvider; client: ProviderClient } | undefined;
}

interface Held {
  tokens: TokenSet;
  account: { id?: string | undefined; label?: string | undefined };
}

interface Flow {
  id: string;
  org: string;
  service: ServiceEntry;
  /** The name a first connect gives its connection. */
  name: string;
  /** The products a first connect turns on, for a service that has them. */
  products: string[] | undefined;
  access: ConnectAccess;
  /** The connection a reconnect is for, or the id a first connect will create. */
  connection: string;
  reconnect: boolean;
  /** The account a reconnect must keep. */
  expected: { id?: string | undefined; label?: string | undefined } | undefined;
  /** The owner confirmed that this server is on their own network. */
  privateNetwork: boolean;
  /** Scopes asked for. */
  requested: string[];
  state: ConnectFlowState;
  message: string;
  url: string | undefined;
  opened: boolean;
  account: string | undefined;
  previousAccount: string | undefined;
  scopes: ConnectScopeLine[];
  test: ConnectionTestResult | undefined;
  pending: Pending | undefined;
  /** The device code, a code sign-in's own page. */
  code: string | undefined;
  /** Set to stop a device poll. */
  stop: { stopped: boolean } | undefined;
  held: Held | undefined;
  expiresAt: number;
  endedAt: number | undefined;
  meta: CommandMeta;
}

class Transient extends Error {}

const unique = (list: readonly string[]) => [...new Set(list)];

/** The id of the transient service of an MCP server added by address. A grant of one has no service. */
const CUSTOM_ID = "custom";

/** An MCP server added by its address: sign-in comes from the server's own metadata, as for any catalog server. */
function customEntry(url: string, name: string, privateNetwork: boolean): ServiceEntry {
  return {
    id: CUSTOM_ID,
    name,
    kind: "mcp-oauth",
    summary: "An MCP server added by its address",
    mcpUrl: url,
    packs: [],
    ready: true,
    verified: false,
    verifiedNote: `Added by address${privateNetwork ? " on the owner's own network" : ""}. The sign-in comes from the server's own metadata.`,
    scopes: [
      {
        id: "mcp",
        access: "write",
        sentence: "Use the server's tools as you. Anything that changes something asks you first.",
      },
    ],
    test: { kind: "mcp-tools", sentence: "Lists the server's tools." },
    docs: url,
  };
}

/**
 * Connect (SPEC 5.14): joins a remote MCP server with OAuth in one click. It runs the attempt (the
 * page, the callback, the exchange, the test), keeps each workspace's grant apart, renews tokens
 * one request at a time and saving the new token before anything uses it, and hands runs a header.
 * Tokens leave this class only as a bearer string for a run's MCP server or a test call.
 */
export class ConnectService {
  private readonly flows = new Map<string, Flow>();
  private readonly byState = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<Grant | undefined>>();
  private readonly backoff = new Map<string, { until: number; step: number }>();
  /** What the last Test of a command-line tool or a token service found. In memory only. */
  private readonly cliStates = new Map<string, { state: ConnectState; reason: string }>();
  private readonly tokenStates = new Map<string, { state: ConnectState; reason: string }>();
  private readonly warned = new Set<string>();
  private readonly discovered = new Map<string, { at: number; found: Discovered }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Host names (any port) of MCP servers added by address that the owner confirmed are on their own
   * network. The server's sign-in may live on another port of the same machine.
   */
  private readonly privateHosts = new Set<string>();
  /** True inside the work of a server added by address: its sign-in metadata is not trusted. */
  private readonly untrusted = new AsyncLocalStorage<boolean>();
  private guarded: Fetch | undefined;

  private readonly appSvc: AppService;

  constructor(private readonly deps: ConnectDeps) {
    this.appSvc = new AppService({
      apps: deps.apps,
      builtIn: deps.builtInApps,
      githubClientId: deps.githubClientId,
      orgName: deps.orgName,
      redirect: deps.redirect,
      fetch: () => this.fetchFn,
      telegramApi: deps.telegramApi,
      observe: (id, result) => this.deps.health?.observe(id, result),
      connections: deps.connections,
      connectionIds: deps.connectionIds,
      secretOf: deps.secretOf,
      changed: deps.changed,
      log: deps.log,
    });
  }

  // -------------------------------------------------------------------------
  // Guided app setup

  appSetup(org: string, app: string, access: ConnectAccess) {
    return this.appSvc.view(org, app, access);
  }
  appStatus(org: string) {
    return this.appSvc.status(org);
  }
  appSave(input: Parameters<AppService["save"]>[0], meta: CommandMeta) {
    return this.appSvc.save(input, meta);
  }
  appForget(org: string, app: string) {
    return this.appSvc.forget(org, app);
  }

  /**
   * Every call to a service. For a server added by address it goes through the host guard: that
   * server can name any address in its sign-in metadata, so a private or metadata address is refused
   * unless the owner confirmed that server's own host. A catalog service is the vendor's own and is not guarded.
   */
  private get fetchFn(): Fetch {
    const base = this.deps.fetch ?? fetch;
    if (this.untrusted.getStore() !== true) return base;
    this.guarded ??= guardedFetch(base, (host) => this.privateHosts.has(bareHost(host)), this.deps.lookup);
    return this.guarded;
  }

  /** Runs `work` as work of a server added by address when the grant is one (it names no catalog service). */
  private forGrant<T>(grant: Grant, work: () => Promise<T>): Promise<T> {
    return grant.service === undefined && grant.provider !== true ? this.untrusted.run(true, work) : work();
  }

  /** The hosts a grant on a confirmed private server may reach again, after a restart. */
  private allowFor(grant: Grant): void {
    if (grant.privateNetwork === true) this.privateHosts.add(new URL(grant.serverUrl).hostname);
  }
  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  private get catalog(): readonly ServiceEntry[] {
    return this.deps.catalog ?? SERVICE_CATALOG;
  }
  private log(line: string): void {
    this.deps.log?.(line);
  }

  // -------------------------------------------------------------------------
  // The catalog and where each connection stands

  catalogView(): ConnectCatalog {
    return {
      services: [...this.catalog],
      redirect: this.deps.redirect,
      helper: this.deps.helperConnected(),
    };
  }

  async status(org?: string): Promise<ConnectStatus[]> {
    const out: ConnectStatus[] = [];
    for (const c of await this.deps.connectionIds()) {
      if (org !== undefined && c.org !== org) continue;
      if (c.connection.type === "cli") {
        out.push(this.cliStatus(c.id, c.org, c.connection));
        continue;
      }
      if (this.isTokenService(c.connection)) {
        out.push(this.tokenStatus(c.id, c.org, c.connection));
        continue;
      }
      if (textValue(c.connection, "auth") !== "oauth") continue;
      out.push(await this.statusOf(c.id, c.org, c.connection));
    }
    return out;
  }

  /** An `env` connection a guided app setup made (Slack, Discord): tokens, no sign-in to renew. */
  private isTokenService(connection: ConnectionConfig): boolean {
    if (connection.type !== "env" && connection.type !== "chat") return false;
    const id = connection.fields?.service;
    const kind = id === undefined ? undefined : this.service(id)?.kind;
    return kind === "api-key" || kind === "token";
  }

  private tokenStatus(id: string, org: string, connection: ConnectionConfig): ConnectStatus {
    const entry = this.service(connection.fields?.service ?? "");
    const account = connection.fields?.account;
    return {
      connection: id,
      org,
      ...(entry === undefined ? {} : { service: entry.id }),
      serviceName: entry?.name ?? connection.name,
      state: this.tokenStates.get(id)?.state ?? "connected",
      reason: this.tokenStates.get(id)?.reason ?? "Connected with its bot token.",
      ...(account === undefined ? {} : { account }),
      scopes: scopeLines(entry, [], connection.fields?.access === "readwrite" ? "readwrite" : "read"),
      missing: [],
      renews: false,
      revocable: entry?.id === "slack",
    };
  }

  private cliStatus(id: string, org: string, connection: ConnectionConfig): ConnectStatus {
    const tool = textValue(connection, "tool") ?? "";
    const entry = this.catalog.find((s) => s.kind === "cli-login" && s.cli === tool);
    const account = textValue(connection, "account");
    const known = this.cliStates.get(id);
    return {
      connection: id,
      org,
      ...(entry === undefined ? {} : { service: entry.id }),
      serviceName: entry?.name ?? connection.name,
      state: known?.state ?? "connected",
      reason: known?.reason ?? "Signed in with the tool's own login.",
      ...(account === undefined ? {} : { account }),
      scopes: scopeLines(entry, [], "readwrite"),
      missing: [],
      renews: false,
      revocable: true,
    };
  }

  private async statusOf(id: string, org: string, connection: ConnectionConfig): Promise<ConnectStatus> {
    const grant = await this.deps.grants.get(id);
    const url = textValue(connection, "url") ?? "";
    const entry =
      (grant?.service === undefined ? undefined : this.service(grant.service)) ??
      (connection.type === "api" ? this.service(textValue(connection, "service") ?? "") : undefined) ??
      serviceByUrl(url, this.catalog);
    const name = entry?.name ?? connection.name;
    if (grant === undefined) {
      return {
        connection: id,
        org,
        ...(entry === undefined ? {} : { service: entry.id }),
        serviceName: name,
        state: "needs-reconnect",
        reason: `majhi has no sign-in for ${name}. Connect it again.`,
        scopes: [],
        missing: [],
        renews: false,
        revocable: false,
      };
    }
    return {
      connection: id,
      org,
      ...(entry === undefined ? {} : { service: entry.id }),
      serviceName: name,
      state: grant.state,
      reason: grant.stateReason !== "" ? grant.stateReason : stateWords(grant.state, name),
      ...(grant.account.label === undefined ? {} : { account: grant.account.label }),
      scopes: scopeLines(entry, grant.tokens.scope, grant.access),
      missing: grant.missing,
      connectedAt: grant.connectedAt,
      ...(grant.tokens.expiresAt === undefined ? {} : { expiresAt: grant.tokens.expiresAt }),
      renews: grant.tokens.refreshToken !== undefined,
      revocable: grant.revocationEndpoint !== undefined,
    };
  }

  private service(id: string): ServiceEntry | undefined {
    return serviceById(id, this.catalog);
  }

  // -------------------------------------------------------------------------
  // Start, watch, cancel

  /** Opens the service's sign-in in the owner's browser and starts waiting. */
  start(input: ConnectStartInput, meta: CommandMeta): Promise<ConnectFlowView> {
    return input.service === undefined
      ? this.untrusted.run(true, () => this.startEntry(input, meta))
      : this.startEntry(input, meta);
  }

  private async startEntry(input: ConnectStartInput, meta: CommandMeta): Promise<ConnectFlowView> {
    this.prune();
    const entry = await this.entryFor(input);
    if (!entry.ready) {
      throw new UserError(`${entry.name} cannot be connected with one click yet. ${entry.note ?? ""}`.trim());
    }
    if (entry.kind === "api-key") {
      throw new UserError(`${entry.name} connects when you save its tokens in its app setup.`, 409);
    }
    if (entry.kind === "token" || entry.kind === "git-host") {
      throw new UserError(
        `${entry.name} connects by pasting a token or signing in to the host, on the Connections page.`,
        409,
      );
    }
    if (entry.kind === "mcp-oauth" && entry.mcpUrl === undefined) {
      throw new UserError(`${entry.name} has no server address.`);
    }
    if (!(await this.deps.orgExists(input.org)))
      throw new UserError(`Org "${input.org}" does not exist.`, 404);

    const all = await this.deps.connectionIds();
    let connection: string;
    let expected: Flow["expected"];
    let requested: string[] = this.scopesFor(entry, input.access);
    const reconnect = input.connection !== undefined;
    if (input.connection !== undefined) {
      const found = all.find((c) => c.id === input.connection);
      if (found === undefined || found.org !== input.org || !isOf(found.connection, entry)) {
        throw new UserError(`${input.connection} is not a connected service of ${input.org}.`, 404);
      }
      connection = found.id;
      if (entry.kind === "cli-login") {
        const account = textValue(found.connection, "account");
        if (account !== undefined) expected = { id: account, label: account };
      } else {
        const grant = await this.deps.grants.get(connection);
        if (grant !== undefined) {
          expected = grant.account;
          // More access: ask for what it already had and what it lacked.
          if (grant.state === "insufficient-scope")
            requested = unique([...grant.requested, ...grant.missing]);
        }
      }
    } else {
      // A workspace may hold several of one service, like two accounts or two teams.
      connection = suggestConnectionId(input.name ?? entry.id, new Set(all.map((c) => c.id)));
    }
    const products = entry.products === undefined ? undefined : this.productsFor(entry, input, all);

    // One attempt per connection: a new click replaces the old one.
    for (const f of this.flows.values()) {
      if (f.connection === connection && f.org === input.org && isLive(f))
        this.end(f, "cancelled", "Replaced by a new attempt.");
    }

    const flow: Flow = {
      id: randomBytes(12).toString("base64url"),
      org: input.org,
      service: entry,
      name: input.name ?? entry.name,
      products,
      access: input.access,
      connection,
      reconnect,
      expected,
      privateNetwork: entry.id === CUSTOM_ID && this.privateHosts.has(bareHost(hostOf(entry.mcpUrl ?? ""))),
      requested,
      state: "waiting",
      message: `Waiting for you in the browser. Approve ${entry.name} there.`,
      url: undefined,
      opened: false,
      account: undefined,
      previousAccount: expected?.label,
      scopes: [],
      test: undefined,
      pending: undefined,
      code: undefined,
      stop: undefined,
      held: undefined,
      expiresAt: this.now().getTime() + FLOW_TTL_MS,
      endedAt: undefined,
      meta,
    };
    if (entry.kind === "cli-login") return this.startCli(flow, entry);
    if (entry.provider !== undefined) return this.startProvider(flow, entry, entry.provider);

    const found = await this.discover(entry.mcpUrl ?? "");
    const client = await this.clientFor(found);
    const state = randomBytes(24).toString("base64url");
    const scope = requested.length === 0 ? undefined : requested.join(" ");
    let started: { url: string; verifier: string };
    try {
      started = await authorizationUrl(found, client, { redirect: this.deps.redirect, scope, state });
    } catch (err) {
      throw this.asUser(err);
    }
    flow.url = started.url;
    flow.pending = { state, verifier: started.verifier, found, client, scope, provider: undefined };
    return this.begin(flow, started.url);
  }

  /**
   * The service to connect: a catalog entry, or for a server added by address a transient one made
   * from the address (or, on a reconnect, from the connection's own grant). Only the owner's own typed
   * address or stored grant gives the address; a private one needs the owner's confirmation.
   */
  private async entryFor(input: ConnectStartInput): Promise<ServiceEntry> {
    if (input.service !== undefined) {
      const entry = this.service(input.service);
      if (entry === undefined) throw new UserError(`There is no service ${input.service}.`, 404);
      return entry;
    }
    let url = input.url;
    let name = input.name;
    let allowPrivate = input.allowPrivate === true;
    if (url === undefined && input.connection !== undefined) {
      const grant = await this.deps.grants.get(input.connection);
      if (grant === undefined) throw new UserError(`${input.connection} has no sign-in to renew.`, 404);
      url = grant.serverUrl;
      allowPrivate = grant.privateNetwork === true;
      name ??= hostOf(url);
    }
    if (url === undefined) throw new UserError("Give a service, or the address of an MCP server.");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(allowPrivate && parsed.protocol === "http:")) {
      throw new UserError("An MCP server's address starts with https://.");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new UserError("Leave the sign-in out of the address.");
    }
    if (allowPrivate) this.privateHosts.add(parsed.hostname);
    return customEntry(parsed.toString(), name ?? parsed.host, allowPrivate);
  }

  /** The products asked for, all known to the service; a reconnect keeps the ones it has. */
  private productsFor(
    entry: ServiceEntry,
    input: ConnectStartInput,
    all: Awaited<ReturnType<ConnectDeps["connectionIds"]>>,
  ): string[] {
    const known = (entry.products ?? []).map((p) => p.id);
    if (input.products === undefined) {
      const had = all.find((c) => c.id === input.connection)?.connection;
      const kept = (textValue(had ?? { type: "mcp", name: "" }, "products") ?? "").split(/\s+/);
      const picked = kept.filter((p) => known.includes(p));
      if (picked.length > 0) return picked;
      throw new UserError(`Pick at least one ${entry.name} product.`);
    }
    const unknown = input.products.filter((p) => !known.includes(p));
    if (unknown.length > 0) throw new UserError(`${entry.name} has no product ${unknown.join(", ")}.`);
    return unique(input.products);
  }

  /** Registers a live flow, opens its page through the helper and tells the screens. */
  private async begin(flow: Flow, page: string): Promise<ConnectFlowView> {
    this.flows.set(flow.id, flow);
    if (flow.pending !== undefined) this.byState.set(flow.pending.state, flow.id);
    flow.opened =
      page !== "" && this.deps.helperConnected() ? await this.deps.openUrl(page).catch(() => false) : false;
    // The address is shown only when majhi could not open it, so a screenshot never holds a live link.
    if (flow.opened) flow.url = undefined;
    this.log(`connect: waiting for ${flow.service.id} in ${flow.org}`);
    this.deps.changed();
    return this.view(flow);
  }

  /** The client ID (and secret) of the app for a workspace: majhi's own public ID, else the owner's. */
  private async providerClient(entry: ServiceEntry, org: string): Promise<ProviderClient> {
    const app = entry.app;
    if (app === undefined) throw new UserError(`${entry.name} has no app setup.`);
    const saved = await this.deps.apps.get(app, org);
    if (saved !== undefined) return { clientId: saved.clientId, clientSecret: saved.clientSecret };
    const builtIn = this.deps.builtInApps?.[entry.id] ?? this.deps.builtInApps?.[app];
    if (builtIn !== undefined && builtIn !== "") return { clientId: builtIn };
    if (app === "github") {
      const shared = await this.deps.githubClientId?.();
      if (shared !== undefined) return { clientId: shared };
    }
    throw new UserError(`Set up the ${entry.name} app first. Open it on the Connections page.`, 409);
  }

  private async startProvider(
    flow: Flow,
    entry: ServiceEntry,
    provider: ServiceProvider,
  ): Promise<ConnectFlowView> {
    const client = await this.providerClient(entry, flow.org);
    if (provider.clientAuth === "secret" && client.clientSecret === undefined) {
      throw new UserError(`The ${entry.name} app has no client secret saved. Set the app up again.`, 409);
    }
    const scope = joinScope(provider, flow.requested);
    if (provider.flow === "device") {
      let device: Awaited<ReturnType<typeof startDevice>>;
      try {
        device = await startDevice(provider, client, scope, this.fetchFn);
      } catch (err) {
        throw this.asUser(err);
      }
      flow.code = device.userCode;
      flow.url = device.verificationUri;
      flow.message = `Enter the code ${device.userCode} on the ${entry.name} page.`;
      flow.expiresAt = Math.min(flow.expiresAt, this.now().getTime() + device.expiresInMs);
      flow.stop = { stopped: false };
      const view = await this.begin(flow, device.verificationUri);
      void this.pollLoop(flow, provider, client, device).catch(() => undefined);
      return view;
    }
    const state = randomBytes(24).toString("base64url");
    const pair = provider.pkce ? pkce() : undefined;
    const page = authorizationPage(provider, client, {
      redirect: this.deps.redirect,
      scope,
      state,
      challenge: pair?.challenge,
    });
    flow.url = page;
    flow.pending = {
      state,
      verifier: pair?.verifier,
      found: undefined,
      client: { clientId: client.clientId, clientSecret: client.clientSecret, via: "dcr" },
      scope,
      provider: { config: provider, client },
    };
    return this.begin(flow, page);
  }

  /** Polls the device grant until the owner answers, with the provider's interval and `slow_down`. */
  private async pollLoop(
    flow: Flow,
    provider: ServiceProvider,
    client: ProviderClient,
    device: { deviceCode: string; intervalMs: number },
  ): Promise<void> {
    let interval = device.intervalMs;
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while (flow.stop?.stopped === false && flow.state === "waiting") {
      await wait(interval);
      if (flow.stop?.stopped !== false || flow.state !== "waiting") return;
      if (this.now().getTime() > flow.expiresAt) {
        this.end(flow, "expired", "The code ran out of time. Nothing was saved. Start again.");
        return;
      }
      let answer: Awaited<ReturnType<typeof pollDevice>>;
      try {
        answer = await pollDevice(provider, client, device.deviceCode, this.fetchFn, () => this.now());
      } catch (err) {
        const message =
          err instanceof ConnectError ? err.message : `${flow.service.name} could not sign you in.`;
        this.end(flow, "failed", `${message} Nothing was saved.`);
        return;
      }
      if (answer.kind === "pending") continue;
      if (answer.kind === "slow-down") {
        interval += 5_000;
        continue;
      }
      if (answer.kind === "denied") {
        this.end(flow, "denied", `You did not allow ${flow.service.name}. Nothing was saved.`);
        return;
      }
      if (answer.kind === "expired") {
        this.end(flow, "expired", "The code ran out of time. Nothing was saved. Start again.");
        return;
      }
      flow.state = "checking";
      flow.message = "Checking the sign-in.";
      flow.code = undefined;
      this.deps.changed();
      try {
        await this.finishProvider(flow, provider, client, answer.tokens);
      } catch (err) {
        const message =
          err instanceof ConnectError ? err.message : `Something went wrong connecting ${flow.service.name}.`;
        this.end(flow, "failed", `${message} Nothing was saved. Start again.`);
        this.log(
          `connect: ${flow.service.id} failed (${err instanceof ConnectError ? err.kind : "internal"})`,
        );
      }
      return;
    }
  }

  /** The tool's own sign-in on the owner's computer, in this connection's folder. */
  private async startCli(flow: Flow, entry: ServiceEntry): Promise<ConnectFlowView> {
    const host = this.deps.cli;
    const tool = entry.cli === undefined ? undefined : cliTool(entry.cli);
    if (host === undefined || tool === undefined || !host.connected()) {
      throw new UserError(
        `${entry.name} signs in on this computer, so majhi's helper has to be running. Start the helper and try again.`,
        409,
      );
    }
    flow.message = `Starting ${tool.name}'s own sign-in.`;
    flow.expiresAt = this.now().getTime() + CLI_FLOW_TTL_MS;
    const view = await this.begin(flow, "");
    // The helper opens the page itself; `begin` has nothing to open here.
    flow.opened = false;
    flow.stop = { stopped: false };
    void this.runCli(flow, entry, tool.name).catch(() => undefined);
    return view;
  }

  private async runCli(flow: Flow, entry: ServiceEntry, toolName: string): Promise<void> {
    const host = this.deps.cli;
    if (host === undefined || entry.cli === undefined) return;
    const signIn = `cli-${flow.id}`;
    try {
      const result = await host.login(
        {
          signIn,
          tool: entry.cli,
          connection: flow.connection,
          ...(flow.reconnect && flow.expected?.label !== undefined ? { expected: flow.expected.label } : {}),
        },
        (page) => {
          if (!isLive(flow)) return;
          flow.url = page.url;
          flow.code = page.code;
          flow.message =
            page.code === undefined
              ? `Approve ${toolName} in the browser page.`
              : `Enter the code ${page.code} on the ${toolName} page.`;
          this.deps.changed();
          // The page is opened by the tool through the helper; the link stays visible as a fallback.
          void (
            this.deps.helperConnected()
              ? this.deps.openUrl(page.url).catch(() => false)
              : Promise.resolve(false)
          ).then((opened) => {
            if (opened && isLive(flow)) flow.opened = true;
            this.deps.changed();
          });
        },
      );
      if (!isLive(flow)) return;
      if (result.state === "cancelled") {
        this.end(flow, "cancelled", "Cancelled. Nothing was saved.");
        return;
      }
      if (result.state === "missing") {
        this.end(
          flow,
          "failed",
          `${toolName} is not installed on this computer. Install it, then try again.`,
        );
        return;
      }
      if (result.state === "other-account") {
        this.end(
          flow,
          "failed",
          `This signed in as ${result.identity ?? "another account"}, but ${entry.name} here is ${flow.expected?.label ?? "another account"}. Nothing changed. Disconnect it first to use another account.`,
        );
        return;
      }
      await this.commitCli(flow, entry, result.identity);
    } catch (err) {
      if (!isLive(flow)) return;
      const message =
        err instanceof Error && err.message !== "" ? err.message : `${toolName} did not sign in.`;
      this.end(flow, "failed", message.endsWith(".") ? message : `${message}.`);
      this.log(`connect: ${entry.id} failed (cli)`);
    }
  }

  private async commitCli(flow: Flow, entry: ServiceEntry, identity: string | undefined): Promise<void> {
    const tool = entry.cli;
    if (tool === undefined) return;
    this.deps.health?.start(flow.connection);
    if (!flow.reconnect) {
      await this.deps.connections
        .create(
          {
            org: flow.org,
            id: flow.connection,
            type: "cli",
            name: flow.name,
            description: `${entry.name}, signed in for this workspace only.`,
            fields: { tool, ...(identity === undefined ? {} : { account: identity }) },
          },
          "connect.start",
          flow.meta,
        )
        .catch(async (err: unknown) => {
          // The sign-in folder must not outlive a connection that was never made.
          await this.deps.cli?.logout({ tool, connection: flow.connection }).catch(() => undefined);
          throw err;
        });
    }
    flow.account = identity;
    flow.scopes = scopeLines(entry, [], "readwrite");
    // The sign-in is not the proof. A real call with it is: the tool's own check command, exit code decides.
    flow.test = await this.testCli(flow.connection, {
      type: "cli",
      name: flow.name,
      fields: { tool, ...(identity === undefined ? {} : { account: identity }) },
    });
    this.deps.health?.observe(flow.connection, flow.test);
    if (!flow.test.ok) {
      this.end(
        flow,
        "failed",
        `${entry.name} signed in, but the check failed. ${flow.test.failure?.fix ?? flow.test.detail}`,
      );
      this.log(`connect: ${entry.id} check failed in ${flow.org}`);
      return;
    }
    this.end(flow, "connected", `Connected${identity === undefined ? "" : ` as ${identity}`}.`);
    this.log(`connect: ${entry.id} connected in ${flow.org}`);
  }

  flow(id: string): ConnectFlowView {
    const flow = this.flows.get(id);
    if (flow === undefined) throw new UserError("That sign-in attempt is gone. Start again.", 404);
    this.expireIfDue(flow);
    return this.view(flow);
  }

  cancel(id: string): ConnectFlowView {
    const flow = this.flows.get(id);
    if (flow === undefined) throw new UserError("That sign-in attempt is gone.", 404);
    if (isLive(flow)) this.end(flow, "cancelled", "Cancelled. Nothing was saved.");
    return this.view(flow);
  }

  private expireIfDue(flow: Flow): void {
    if (flow.state === "waiting" && this.now().getTime() > flow.expiresAt) {
      this.end(flow, "expired", "The sign-in page timed out. Nothing was saved. Start again.");
    }
  }

  private end(flow: Flow, state: ConnectFlowState, message: string): void {
    flow.state = state;
    flow.message = message;
    flow.endedAt = this.now().getTime();
    flow.url = undefined;
    flow.code = undefined;
    if (flow.stop !== undefined) flow.stop.stopped = true;
    if (flow.service.kind === "cli-login" && (state === "cancelled" || state === "expired")) {
      void this.deps.cli?.cancel(`cli-${flow.id}`).catch(() => undefined);
    }
    if (flow.pending !== undefined) this.byState.delete(flow.pending.state);
    flow.pending = undefined;
    if (state !== "confirm-account") flow.held = undefined;
    this.deps.changed();
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, f] of this.flows) {
      this.expireIfDue(f);
      if (f.endedAt !== undefined && now - f.endedAt > ENDED_KEEP_MS) this.flows.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // The callback

  /**
   * The service sent the owner back. Checks `state` (known, unused, not expired), `iss` and the
   * error, then redeems the code and finishes. Returns the sentence for the page the owner sees.
   */
  async callback(params: URLSearchParams): Promise<{ ok: boolean; message: string }> {
    const state = params.get("state");
    const id = state === null ? undefined : this.byState.get(state);
    const flow = id === undefined ? undefined : this.flows.get(id);
    const pending = flow?.pending;
    if (state === null || flow === undefined || pending === undefined || pending.state !== state) {
      // Unknown, used or from another attempt. Nothing is changed and nothing is said about why.
      return {
        ok: false,
        message: "majhi did not start this sign-in, or it was already used. Start again from majhi.",
      };
    }
    // Single use: the state cannot be presented twice.
    this.byState.delete(state);
    flow.pending = undefined;
    if (this.now().getTime() > flow.expiresAt) {
      this.end(flow, "expired", "The sign-in page timed out. Nothing was saved. Start again.");
      return { ok: false, message: flow.message };
    }
    if (params.get("error") !== null) {
      const denied = params.get("error") === "access_denied";
      this.end(
        flow,
        denied ? "denied" : "failed",
        denied
          ? `You did not allow ${flow.service.name}. Nothing was saved.`
          : `${flow.service.name} could not sign you in. Nothing was saved. Try again.`,
      );
      return { ok: false, message: flow.message };
    }
    const iss = params.get("iss");
    const expectIss = issuerExpectation(pending);
    if (issuerWrong(iss, expectIss)) {
      this.end(flow, "failed", "The answer did not come from the service majhi asked. Nothing was saved.");
      return { ok: false, message: flow.message };
    }
    const code = params.get("code");
    if (code === null || code === "") {
      this.end(flow, "failed", `${flow.service.name} sent no code. Nothing was saved. Try again.`);
      return { ok: false, message: flow.message };
    }
    flow.state = "checking";
    flow.message = "Checking the sign-in.";
    this.deps.changed();
    try {
      await (flow.service.id === CUSTOM_ID
        ? this.untrusted.run(true, () => this.finish(flow, pending, code))
        : this.finish(flow, pending, code));
    } catch (err) {
      const message =
        err instanceof ConnectError ? err.message : `Something went wrong connecting ${flow.service.name}.`;
      this.end(flow, "failed", `${message} Nothing was saved. Start again.`);
      this.log(`connect: ${flow.service.id} failed (${err instanceof ConnectError ? err.kind : "internal"})`);
    }
    return { ok: endedWell(flow), message: flow.message };
  }

  private async finish(flow: Flow, pending: Pending, code: string): Promise<void> {
    if (pending.provider !== undefined) {
      const tokens = await exchangeCode(
        pending.provider.config,
        pending.provider.client,
        { code, verifier: pending.verifier, redirect: this.deps.redirect },
        this.fetchFn,
        () => this.now(),
      );
      await this.finishProvider(flow, pending.provider.config, pending.provider.client, tokens);
      return;
    }
    const found = pending.found;
    if (found === undefined || pending.verifier === undefined) {
      throw new ConnectError("The sign-in lost its place. Start again.", "protocol");
    }
    const tokens = await exchange(
      found,
      pending.client,
      { redirect: this.deps.redirect, code, verifier: pending.verifier },
      this.fetchFn,
      () => this.now(),
    );
    const account = await identify(tokens, found.metadata, this.fetchFn);
    await this.settle(flow, found, pending.client, tokens, account, undefined);
  }

  /** A provider's tokens in hand: asks it who signed in (which also proves the token), then settles. */
  private async finishProvider(
    flow: Flow,
    provider: ServiceProvider,
    client: ProviderClient,
    tokens: TokenSet,
  ): Promise<void> {
    const probe = await probeProvider(provider, tokens.accessToken, this.fetchFn);
    if (probe.kind === "invalid") {
      throw new ConnectError(`${flow.service.name} did not accept the new sign-in.`, "refused");
    }
    if (probe.kind === "unreachable") {
      throw new ConnectError(`majhi could not reach ${flow.service.name} to check the sign-in.`, "network");
    }
    const account = probe.kind === "ok" ? probe.identity : {};
    await this.settle(
      flow,
      undefined,
      { clientId: client.clientId, clientSecret: client.clientSecret, via: "dcr" },
      tokens,
      account,
      provider,
    );
  }

  /** Holds a sign-in as another account for the owner's answer, or saves it. */
  private async settle(
    flow: Flow,
    found: Discovered | undefined,
    client: ClientIdentity,
    tokens: TokenSet,
    account: Held["account"],
    provider: ServiceProvider | undefined,
  ): Promise<void> {
    flow.account = account.label;
    const expected = flow.expected;
    if (
      flow.reconnect &&
      expected?.id !== undefined &&
      account.id !== undefined &&
      expected.id !== account.id
    ) {
      // Nothing is replaced until the owner says so.
      flow.held = { tokens, account };
      flow.state = "confirm-account";
      flow.message = `This signed in as ${account.label ?? "another account"}, but ${flow.service.name} here is ${expected.label ?? "another account"}. Nothing changed.`;
      flow.expiresAt = this.now().getTime() + FLOW_TTL_MS;
      this.deps.changed();
      return;
    }
    await this.commit(flow, found, client, tokens, account, provider);
  }

  /** The owner answers a reconnect that signed in as another account. */
  async confirmAccount(id: string, accept: boolean): Promise<ConnectFlowView> {
    const flow = this.flows.get(id);
    if (flow === undefined) throw new UserError("That sign-in attempt is gone. Start again.", 404);
    const held = flow.held;
    if (flow.state !== "confirm-account" || held === undefined) {
      throw new UserError("That sign-in is not waiting for an answer.", 409);
    }
    const provider = flow.service.provider;
    const found = provider === undefined ? await this.discover(flow.service.mcpUrl ?? "") : undefined;
    const client: ClientIdentity =
      found !== undefined
        ? await this.clientFor(found)
        : { ...(await this.providerClient(flow.service, flow.org)), via: "dcr" };
    if (!accept) {
      // The other account's sign-in must not linger at the service.
      await this.revokeTokens(
        found === undefined ? provider?.revokeUrl : revocationEndpointOf(found.metadata),
        client,
        held.tokens,
      );
      this.end(
        flow,
        "cancelled",
        `Kept ${flow.expected?.label ?? "the old account"}. The other sign-in was dropped.`,
      );
      return this.view(flow);
    }
    const old = await this.deps.grants.get(flow.connection);
    flow.state = "checking";
    try {
      await this.commit(flow, found, client, held.tokens, held.account, provider);
    } catch (err) {
      const message = err instanceof ConnectError ? err.message : "Something went wrong.";
      this.end(flow, "failed", `${message} Nothing was saved.`);
      return this.view(flow);
    }
    // The account that was replaced loses its access too.
    if (old !== undefined) await this.revokeGrant(old);
    return this.view(flow);
  }

  /** Tests the token, then saves the grant (and the connection for a first connect). */
  private async commit(
    flow: Flow,
    found: Discovered | undefined,
    client: ClientIdentity,
    tokens: TokenSet,
    account: Held["account"],
    provider: ServiceProvider | undefined,
  ): Promise<void> {
    const entry = flow.service;
    const url = entry.mcpUrl ?? provider?.identity.url ?? "";
    const probe: TokenProbe =
      provider !== undefined && entry.mcpUrl === undefined
        ? asTokenProbe(await probeProvider(provider, tokens.accessToken, this.fetchFn))
        : await probeToken(url, tokens.accessToken, this.fetchFn);
    let state: ConnectState = "connected";
    let reason = "";
    let missing: string[] = [];
    if (probe.kind === "invalid") {
      throw new ConnectError(`${entry.name} did not accept the new sign-in.`, "refused");
    }
    const granted = tokens.scope ?? flow.requested;
    if (tokens.scope !== undefined && flow.requested.length > 0) {
      missing = flow.requested.filter((s) => !tokens.scope?.includes(s));
    }
    if (probe.kind === "insufficient-scope") missing = unique([...missing, ...probe.scope]);
    if (missing.length > 0) {
      state = "insufficient-scope";
      reason = `${entry.name} gave less access than asked for: ${missing.join(", ")} is missing. Reconnect and allow it.`;
    }
    const now = this.now().toISOString();
    const grant: Grant = {
      v: 1,
      connection: flow.connection,
      org: flow.org,
      ...(entry.id === CUSTOM_ID ? {} : { service: entry.id }),
      ...(flow.privateNetwork ? { privateNetwork: true as const } : {}),
      serverUrl: url,
      resource: found?.resource ?? url,
      issuer: found?.issuer ?? provider?.issuer ?? hostOf(provider?.tokenUrl ?? url),
      authorizationServerUrl:
        found?.authorizationServerUrl ?? provider?.authorizeUrl ?? provider?.tokenUrl ?? url,
      ...(revokeAt(found, provider) === undefined ? {} : { revocationEndpoint: revokeAt(found, provider) }),
      ...(provider === undefined ? {} : { provider: true as const }),
      clientId: client.clientId,
      state,
      stateReason: reason,
      tokens: {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
        ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
        scope: granted,
      },
      missing,
      requested: flow.requested,
      access: flow.access,
      // Google ends the sign-in of an app in Testing after 7 days, and says so in the token answer.
      ...(tokens.refreshExpiresIn !== undefined && tokens.refreshExpiresIn <= 8 * 86_400
        ? { testing: true as const }
        : {}),
      account: {
        ...(account.id === undefined ? {} : { id: account.id }),
        ...(account.label === undefined ? {} : { label: account.label }),
      },
      connectedAt: now,
      updatedAt: now,
    };
    this.deps.health?.start(flow.connection);
    if (!flow.reconnect) {
      await this.deps.connections.create(
        {
          org: flow.org,
          id: flow.connection,
          ...(entry.mcpUrl === undefined
            ? {
                type: "api" as const,
                name: flow.name,
                description: `${entry.summary}. Runs get a short-lived token in ${provider?.tokenVar ?? "ACCESS_TOKEN"}.`,
                fields: { service: entry.id, auth: "oauth", token_var: provider?.tokenVar ?? "ACCESS_TOKEN" },
              }
            : {
                type: "mcp" as const,
                name: flow.name,
                description: entry.summary,
                fields: {
                  transport: "remote",
                  url,
                  protocol: "http",
                  auth: "oauth",
                  ...(flow.products === undefined ? {} : { products: flow.products.join(" ") }),
                },
              }),
        },
        "connect.start",
        flow.meta,
      );
    }
    try {
      await this.deps.grants.save(grant);
    } catch (err) {
      if (!flow.reconnect)
        await this.deps.connections
          .remove(flow.connection, "connect.start", flow.meta)
          .catch(() => undefined);
      throw err;
    }
    this.backoff.delete(flow.connection);
    if (found !== undefined) this.discovered.set(found.issuer, { at: this.now().getTime(), found });
    flow.scopes = scopeLines(entry, granted, flow.access);
    if (state === "insufficient-scope") {
      this.deps.attention?.({
        org: flow.org,
        key: `connect:${flow.connection}:scope:${missing.join(",")}`,
        title: `${entry.name} asks for more access`,
        detail: `${reason} Open Connections, pick ${entry.name} and choose Allow more access.`,
      });
    }
    flow.test = await this.testGrant(grant);
    this.deps.health?.observe(flow.connection, flow.test);
    if (!flow.test.ok) {
      // Signed in is not connected. The connection stays, as failed, with the exact fix.
      this.end(
        flow,
        "failed",
        `${entry.name} accepted the sign-in, but the check failed. ${flow.test.failure?.fix ?? flow.test.detail}`,
      );
      this.log(`connect: ${entry.id} check failed in ${flow.org}`);
      return;
    }
    this.end(
      flow,
      "connected",
      state === "insufficient-scope"
        ? reason
        : `Connected${account.label === undefined ? "" : ` as ${account.label}`}.`,
    );
    this.log(`connect: ${entry.id} connected in ${flow.org}`);
  }

  // -------------------------------------------------------------------------
  // Tokens: fresh, single flight, saved before use

  /**
   * A bearer token for a run's MCP server or a test: renewed first when it ends within five
   * minutes. Returns a sentence instead when the connection has no usable sign-in.
   */
  async bearer(connection: string): Promise<{ token: string } | { problem: string }> {
    let grant: Grant | undefined;
    try {
      grant = await this.ensureFresh(connection);
    } catch (err) {
      if (!(err instanceof Transient)) throw err;
      // The service is unreachable. A token that has not ended still works.
      grant = await this.deps.grants.get(connection);
      if (grant === undefined || isExpired(grant, this.now())) {
        return {
          problem: "The service is unreachable, so its token could not be renewed. majhi tries again soon.",
        };
      }
    }
    if (grant === undefined) {
      return { problem: "majhi has no sign-in for it. Connect it again on the Connections page." };
    }
    if (grant.state === "needs-reconnect" || grant.state === "revoked") {
      return { problem: grant.stateReason || stateWords(grant.state, this.nameOf(grant)) };
    }
    return { token: grant.tokens.accessToken };
  }

  /** Renews the grant when its access token ends soon. One request at a time per connection. */
  async ensureFresh(
    connection: string,
    options: { force?: boolean; skewMs?: number } = {},
  ): Promise<Grant | undefined> {
    const grant = await this.deps.grants.get(connection);
    if (grant === undefined || grant.state === "needs-reconnect" || grant.state === "revoked") return grant;
    const skew = options.skewMs ?? REFRESH_SKEW_MS;
    const due =
      grant.tokens.expiresAt !== undefined &&
      Date.parse(grant.tokens.expiresAt) - this.now().getTime() < skew;
    if (options.force !== true && !due) return grant;
    if (grant.tokens.refreshToken === undefined) {
      if (isExpired(grant, this.now())) {
        return this.markState(
          connection,
          "needs-reconnect",
          `${this.nameOf(grant)} ended the sign-in and gave no renewal. Reconnect it.`,
        );
      }
      return grant;
    }
    const running = this.inflight.get(connection);
    if (running !== undefined) return running;
    const flight = this.renew(connection, options.force === true, skew).finally(() =>
      this.inflight.delete(connection),
    );
    this.inflight.set(connection, flight);
    return flight;
  }

  private async renew(connection: string, force: boolean, skew: number): Promise<Grant | undefined> {
    // Another flight may have renewed it between the check and here.
    const grant = await this.deps.grants.get(connection);
    if (grant === undefined || grant.tokens.refreshToken === undefined) return grant;
    this.allowFor(grant);
    const due =
      grant.tokens.expiresAt !== undefined &&
      Date.parse(grant.tokens.expiresAt) - this.now().getTime() < skew;
    if (!force && !due) return grant;
    const wait = this.backoff.get(connection);
    if (wait !== undefined && wait.until > this.now().getTime()) {
      if (isExpired(grant, this.now())) throw new Transient();
      return grant;
    }
    let tokens: TokenSet;
    try {
      tokens = await this.forGrant(grant, async () => {
        if (grant.provider === true) {
          return this.renewProvider(grant, grant.tokens.refreshToken ?? "");
        }
        const found = await this.discover(grant.serverUrl, grant.issuer);
        const client = await this.clientOf(grant);
        return refresh(
          found,
          client,
          { redirect: this.deps.redirect, refreshToken: grant.tokens.refreshToken ?? "" },
          this.fetchFn,
          () => this.now(),
        );
      });
    } catch (err) {
      if (err instanceof ConnectError && err.kind === "refused") {
        this.log(`connect: ${grant.service ?? connection} needs reconnect`);
        return this.markState(
          connection,
          "needs-reconnect",
          `${this.nameOf(grant)} no longer accepts majhi's sign-in.${grant.provider === true ? ` ${this.service(grant.service ?? "")?.provider?.refusedHint ?? ""}`.trimEnd() : ""} Reconnect it.`,
        );
      }
      const step = Math.min((wait?.step ?? BACKOFF_FIRST_MS / 2) * 2, BACKOFF_MAX_MS);
      this.backoff.set(connection, { until: this.now().getTime() + step, step });
      this.log(`connect: ${grant.service ?? connection} could not renew; will retry`);
      throw new Transient();
    }
    this.backoff.delete(connection);
    // The new refresh token is saved before the new access token is handed to anyone.
    const saved = await this.deps.grants.update(connection, (g) => ({
      ...g,
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? g.tokens.refreshToken,
        ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
        scope: tokens.scope ?? g.tokens.scope,
      },
      updatedAt: this.now().toISOString(),
    }));
    this.deps.changed();
    return saved;
  }

  /** Renews a provider's token with the workspace's own app. A forgotten app means a new sign-in. */
  private async renewProvider(grant: Grant, refreshToken: string): Promise<TokenSet> {
    const entry = grant.service === undefined ? undefined : this.service(grant.service);
    if (entry?.provider === undefined) throw new ConnectError("The service is no longer listed.", "refused");
    let client: ProviderClient;
    try {
      client = await this.providerClient(entry, grant.org);
    } catch {
      throw new ConnectError(`The ${entry.name} app was removed.`, "refused");
    }
    return refreshTokens(entry.provider, client, refreshToken, this.fetchFn, () => this.now());
  }

  private async markState(
    connection: string,
    state: ConnectState,
    reason: string,
  ): Promise<Grant | undefined> {
    const before = await this.deps.grants.get(connection);
    const saved = await this.deps.grants.update(connection, (g) => ({
      ...g,
      state,
      stateReason: reason,
      updatedAt: this.now().toISOString(),
    }));
    if (state === "needs-reconnect" || state === "revoked") {
      this.deps.health?.failed(connection, {
        reason: state === "revoked" ? "rejected" : "expired",
        fix: "Sign in again.",
      });
    }
    this.deps.changed();
    if (before !== undefined && before.state !== state) {
      this.deps.attention?.({
        org: before.org,
        key: `connect:${connection}:${state}`,
        title: `${this.nameOf(before)} needs you to sign in again`,
        detail: `${reason} Open Connections, pick ${this.nameOf(before)} and choose Reconnect.`,
      });
    }
    return saved;
  }

  private nameOf(grant: Grant): string {
    return (
      (grant.service === undefined ? undefined : this.service(grant.service)?.name) ?? hostOf(grant.serverUrl)
    );
  }

  // -------------------------------------------------------------------------
  // Test, scope, disconnect

  /** The Test of an OAuth connection: renews, calls the server with the token, lists its tools. */
  async test(connection: string): Promise<ConnectionTestResult> {
    const found = (await this.deps.connectionIds()).find((c) => c.id === connection);
    if (found?.connection.type === "cli") return this.testCli(found.id, found.connection);
    if (found !== undefined && this.isTokenService(found.connection)) {
      const service = found.connection.fields?.service ?? "";
      const tokenEntry = this.service(service);
      if (tokenEntry?.kind === "token" && tokenEntry.token !== undefined) {
        const result = await this.testToken(found.id, tokenEntry);
        this.tokenStates.set(found.id, {
          state: result.ok ? "connected" : "error",
          reason: result.ok ? "Connected with its token." : (result.failure?.fix ?? result.detail),
        });
        this.deps.changed();
        return result;
      }
      const result = await this.appSvc.test(found.id, service);
      this.tokenStates.set(found.id, {
        state: result.ok ? "connected" : "error",
        reason: result.ok ? "Connected with its bot token." : result.detail,
      });
      this.deps.changed();
      return result;
    }
    const grant = await this.deps.grants.get(connection);
    if (grant === undefined) {
      return this.result(false, "majhi has no sign-in for it. Connect it again.", Date.now(), undefined, {
        reason: "no-credential",
      });
    }
    return this.testGrant(grant);
  }

  /** The Test of a pasted token: one real call with it, decided by the status. */
  private async testToken(id: string, entry: ServiceEntry): Promise<ConnectionTestResult> {
    const started = Date.now();
    const method = entry.token;
    if (method === undefined) {
      return this.result(false, `${entry.name} has no token check.`, started, undefined, {
        reason: "unexpected",
      });
    }
    const token = await this.deps.secretOf(id, method.variable);
    if (token === undefined) {
      return this.result(false, "The token is not saved. Paste it again.", started, undefined, {
        reason: "no-credential",
        fix: "Paste the token again.",
        fixUrl: method.page.url,
      });
    }
    const checked = await checkToken(this.fetchFn, method, token);
    if (!checked.ok) {
      return this.result(false, `${entry.name} did not pass the check.`, started, undefined, checked.failure);
    }
    return this.result(
      true,
      `${entry.name}: the token works for ${checked.account}.`,
      started,
      undefined,
      undefined,
      {
        checked: checked.checked,
        account: checked.account,
      },
    );
  }

  /**
   * Connects a service by a pasted token. The token is checked first with a real call, so a wrong one
   * saves nothing. A good one makes the connection and checks it again through the stored secret, so
   * "connected" is what the next run will get.
   */
  async connectToken(
    input: { org: string; service: string; token: string; name?: string | undefined },
    meta: CommandMeta,
  ): Promise<{ ok: true; connection: string; account: string } | { ok: false; failure: ConnectionFailure }> {
    const entry = this.service(input.service);
    const method = entry?.token;
    if (entry === undefined || entry.kind !== "token" || method === undefined) {
      throw new UserError(`${input.service} is not connected by a token.`, 404);
    }
    if (!(await this.deps.orgExists(input.org)))
      throw new UserError(`Org "${input.org}" does not exist.`, 404);
    const verified = await checkToken(this.fetchFn, method, input.token);
    if (!verified.ok) return verified;
    const all = await this.deps.connectionIds();
    const id = suggestConnectionId(input.name ?? entry.id, new Set(all.map((c) => c.id)));
    this.deps.health?.start(id);
    try {
      await this.deps.connections.create(
        {
          org: input.org,
          id,
          type: "env",
          name: input.name ?? entry.name,
          description: `${entry.name}, with a token of this workspace. Variable ${method.variable} holds it. Anything that changes something asks the owner first.`,
          fields: { service: entry.id, access: "read", account: verified.account },
          vars: { [method.variable]: { kind: "secret" } },
        },
        "connections.connectToken",
        meta,
      );
      await this.deps.connections.setSecret?.(
        { id, field: method.variable, list: "vars", value: input.token },
        "connections.connectToken",
        meta,
      );
    } catch (err) {
      await this.deps.connections.remove(id, "connections.connectToken", meta).catch(() => undefined);
      this.deps.health?.remove(id);
      throw err;
    }
    const test = await this.testToken(id, entry);
    this.deps.health?.observe(id, test);
    this.deps.changed();
    this.log(`connect: ${entry.id} connected by token in ${input.org}`);
    return { ok: true, connection: id, account: verified.account };
  }

  /** A command-line tool's Test: its own who-am-I command, in this workspace's folder. */
  private async testCli(id: string, connection: ConnectionConfig): Promise<ConnectionTestResult> {
    const started = Date.now();
    const tool = cliTool(textValue(connection, "tool") ?? "");
    const host = this.deps.cli;
    if (tool === undefined) {
      return this.result(false, "That tool is not known to majhi.", started, undefined, {
        reason: "unexpected",
        fix: "Remove this connection and connect the tool again.",
      });
    }
    if (host === undefined || !host.connected()) {
      return this.result(
        false,
        "majhi's helper is not running, so the tool cannot be checked now.",
        started,
        undefined,
        { reason: "helper-offline" },
      );
    }
    try {
      const checked = await host.check({ tool: tool.id, connection: id });
      this.cliStates.set(id, {
        state: checked.ok ? "connected" : "needs-reconnect",
        reason: checked.ok ? "Signed in with the tool's own login." : `${checked.detail} Reconnect it.`,
      });
      this.deps.changed();
      return this.result(
        checked.ok,
        checked.ok
          ? `${tool.name}: signed in${checked.identity === undefined ? "" : ` as ${checked.identity}`}.`
          : checked.detail,
        started,
        undefined,
        checked.ok
          ? undefined
          : {
              // The helper read the tool's exit code: 127 or no program, none, or any other.
              reason:
                checked.failure === "tool-missing"
                  ? "tool-missing"
                  : checked.failure === "timeout"
                    ? "timeout"
                    : "not-signed-in",
            },
        checked.ok
          ? {
              checked: [`Ran ${tool.binary} ${tool.check.join(" ")} in this workspace's profile, exit 0`],
              ...(checked.identity === undefined ? {} : { account: checked.identity }),
            }
          : undefined,
      );
    } catch {
      return this.result(false, "majhi's helper did not answer. Try again.", started, undefined, {
        reason: "helper-offline",
      });
    }
  }

  private testGrant(first: Grant): Promise<ConnectionTestResult> {
    return this.forGrant(first, () => this.testGrantInner(first));
  }

  private async testGrantInner(first: Grant): Promise<ConnectionTestResult> {
    const started = Date.now();
    let grant: Grant | undefined = first;
    this.allowFor(first);
    try {
      grant = (await this.ensureFresh(first.connection)) ?? first;
    } catch (err) {
      if (!(err instanceof Transient)) throw err;
    }
    if (grant.state === "needs-reconnect" || grant.state === "revoked") {
      return this.result(
        false,
        grant.stateReason || stateWords(grant.state, this.nameOf(grant)),
        started,
        undefined,
        { reason: grant.state === "revoked" ? "rejected" : "expired" },
      );
    }
    const apiEntry = grant.provider === true ? this.service(grant.service ?? "") : undefined;
    const apiOnly = apiEntry?.provider !== undefined && apiEntry.mcpUrl === undefined;
    let identityLabel: string | undefined;
    const probeNow = async (g: Grant): Promise<TokenProbe> => {
      if (apiOnly && apiEntry?.provider !== undefined) {
        const answer = await probeProvider(apiEntry.provider, g.tokens.accessToken, this.fetchFn);
        if (answer.kind === "ok") identityLabel = answer.identity.label;
        return asTokenProbe(answer);
      }
      return probeToken(g.serverUrl, g.tokens.accessToken, this.fetchFn);
    };
    let probe = await probeNow(grant);
    if (probe.kind === "invalid" && grant.tokens.refreshToken !== undefined) {
      // The access token may have been cut short. One forced renewal tells that from a revoked grant.
      try {
        grant = (await this.ensureFresh(grant.connection, { force: true })) ?? grant;
      } catch (err) {
        if (!(err instanceof Transient)) throw err;
      }
      if (grant.state === "needs-reconnect") {
        return this.result(false, grant.stateReason, started, undefined, { reason: "expired" });
      }
      probe = await probeNow(grant);
    }
    const name = this.nameOf(grant);
    if (probe.kind === "invalid") {
      await this.markState(
        grant.connection,
        "revoked",
        `${name} no longer accepts majhi. The access was revoked. Reconnect it.`,
      );
      return this.result(
        false,
        `${name} no longer accepts majhi. The access was revoked. Reconnect it.`,
        started,
        undefined,
        { reason: "rejected", status: 401 },
      );
    }
    if (probe.kind === "insufficient-scope") {
      const missing = probe.scope;
      await this.markScope(grant.connection, missing);
      return this.result(
        false,
        `${name} needs more access${missing.length > 0 ? ` (${missing.join(", ")})` : ""}. Reconnect and allow it.`,
        started,
        undefined,
        { reason: "insufficient-scope", status: 403 },
      );
    }
    if (probe.kind === "other") {
      const why = probe.reason === "" ? "" : `: ${probe.reason}`;
      const hint =
        this.service(grant.service ?? "")?.enableHint ??
        `Your account may not have ${name}'s MCP server turned on.`;
      const typed = failureFromHttp(probe.status);
      const enableHint = this.service(grant.service ?? "")?.enableHint;
      if (probe.disabled !== undefined) {
        // Google's API is off for the owner's project: the answer says so, and where to turn it on.
        return this.result(
          false,
          `The ${apiEntry?.name ?? name} API is turned off in your Google project.`,
          started,
          undefined,
          {
            reason: "setup-needed",
            status: 403,
            fix: `Turn on the ${apiEntry?.name ?? name} API in your Google project, then check again.`,
            ...(probe.disabled.url === undefined ? {} : { fixUrl: probe.disabled.url }),
          },
        );
      }
      return this.result(
        false,
        `${name} refused majhi's calls (${probe.status}${why}). ${hint} The sign-in is kept.`,
        started,
        undefined,
        {
          // A 403 from a server that has an own switch is that switch being off.
          reason: probe.status === 403 && enableHint !== undefined ? "setup-needed" : (typed ?? "unexpected"),
          status: probe.status,
          ...(probe.status === 403 ? { fix: hint } : {}),
        },
      );
    }
    if (probe.kind === "slow") {
      return this.result(
        false,
        `${hostOf(grant.serverUrl)} took the call but did not answer in 15 seconds. The sign-in is kept; try again.`,
        started,
        undefined,
        { reason: "timeout" },
      );
    }
    if (probe.kind === "unreachable") {
      return this.result(
        false,
        `majhi could not reach ${hostOf(grant.serverUrl)} just now. The sign-in is kept; try again.`,
        started,
        undefined,
        { reason: "unreachable" },
      );
    }
    if (apiOnly) {
      if (grant.state === "error") await this.markState(grant.connection, "connected", "");
      // A Google app still in Testing ends its sign-in after 7 days: connected today, dead next week.
      if (grant.testing === true) {
        return this.result(
          false,
          `The ${name} app is still in Testing, so Google ends this sign-in after 7 days.`,
          started,
          undefined,
          {
            reason: "app-in-testing",
            fix: "Publish the app in the Google console (Audience, Publish app), then sign in once more.",
            fixUrl: "https://console.cloud.google.com/auth/audience",
          },
        );
      }
      return this.result(
        true,
        `Signed in${identityLabel === undefined ? "" : ` as ${identityLabel}`}.`,
        started,
        undefined,
        undefined,
        {
          checked: [`Called ${apiEntry?.name ?? name}'s API with the stored sign-in`],
          ...(identityLabel === undefined ? {} : { account: identityLabel }),
        },
      );
    }
    const products = await this.productsOf(grant);
    if (products !== undefined) return this.testProducts(grant, products, started);
    try {
      const listed = await this.deps.listTools(grant.serverUrl, grant.tokens.accessToken);
      const tools = listed.map((t) => t.name);
      const toolAnnotations = annotationsOf(listed);
      if (grant.state === "error") await this.markState(grant.connection, "connected", "");
      return this.result(
        true,
        `${tools.length} tool${tools.length === 1 ? "" : "s"}${tools.length > 0 ? `: ${tools.slice(0, 4).join(", ")}${tools.length > 4 ? ", ..." : ""}` : ""}`,
        started,
        tools,
        undefined,
        {
          checked: [
            `Called ${name}'s MCP server with the stored sign-in (initialize)`,
            `Listed ${tools.length} tool${tools.length === 1 ? "" : "s"} (tools/list)`,
          ],
          ...(grant.account.label === undefined ? {} : { account: grant.account.label }),
          ...(toolAnnotations === undefined ? {} : { toolAnnotations }),
        },
      );
    } catch (err) {
      // The error's code decides: an HTTP status the server gave, or an MCP error code.
      return this.result(
        false,
        `${name} signed majhi in but would not list its tools. Try again.`,
        started,
        undefined,
        { reason: failureFromError(err) },
      );
    }
  }

  /** The products a connection has turned on, for a service that has them. */
  private async productsOf(grant: Grant): Promise<ServiceProduct[] | undefined> {
    const entry = this.service(grant.service ?? "");
    if (entry?.products === undefined) return undefined;
    const found = await this.deps.connections.find(grant.connection);
    const picked = (found === undefined ? "" : (textValue(found.connection, "products") ?? "")).split(/\s+/);
    return entry.products.filter((p) => picked.includes(p.id));
  }

  /** Lists the tools of each product with the one sign-in; one that refuses is named. */
  private async testProducts(
    grant: Grant,
    products: readonly ServiceProduct[],
    started: number,
  ): Promise<ConnectionTestResult> {
    if (products.length === 0) {
      return this.result(false, "No product is picked. Pick at least one.", started, undefined, {
        reason: "setup-needed",
        fix: "Pick at least one product on the connection.",
      });
    }
    const lines: string[] = [];
    const tools: string[] = [];
    const annotations: NonNullable<ConnectionTestResult["toolAnnotations"]> = {};
    const failed: string[] = [];
    let lastError: unknown;
    for (const product of products) {
      try {
        const listed = await this.deps.listTools(product.mcpUrl, grant.tokens.accessToken);
        tools.push(...listed.map((t) => t.name));
        Object.assign(annotations, annotationsOf(listed));
        lines.push(`${product.name}: ${listed.length} tool${listed.length === 1 ? "" : "s"}`);
      } catch (err) {
        const why = refusalReason(null, JSON.stringify({ message: errorText(err) }));
        failed.push(`${product.name} failed${why === "" ? "" : ` (${why})`}`);
        lastError = err;
      }
    }
    if (lines.length === 0) {
      return this.result(false, `${failed.join(". ")}.`, started, tools, {
        reason: failureFromError(lastError),
      });
    }
    if (grant.state === "error") await this.markState(grant.connection, "connected", "");
    // A product the account may not use (billing for a member without it) is a warning: the
    // other products work, and agents get them.
    return {
      ...this.result(true, `${lines.join(". ")}.`, started, tools, undefined, {
        checked: [
          `Listed the tools of ${lines.length} product${lines.length === 1 ? "" : "s"} with the stored sign-in`,
        ],
        ...(grant.account.label === undefined ? {} : { account: grant.account.label }),
        ...(Object.keys(annotations).length === 0 ? {} : { toolAnnotations: annotations }),
      }),
      warnings: failed.map((f) => `${f}. Agents still get the other products.`),
    };
  }

  private result(
    ok: boolean,
    detail: string,
    started: number,
    tools?: string[],
    failure?: ConnectionFailure,
    passed?: {
      checked: string[];
      account?: string;
      toolAnnotations?: ConnectionTestResult["toolAnnotations"];
    },
  ): ConnectionTestResult {
    return {
      ok,
      detail,
      ...(tools === undefined ? {} : { tools }),
      warnings: [],
      at: this.now().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
      ...(failure === undefined ? {} : { failure }),
      ...(passed === undefined ? {} : passed),
    };
  }

  /** A tool call failed with 403 insufficient_scope: shows it and asks the owner. */
  async needScope(connection: string, scope: string | undefined): Promise<ConnectStatus> {
    const found = (await this.deps.connectionIds()).find((c) => c.id === connection);
    if (found === undefined || textValue(found.connection, "auth") !== "oauth") {
      throw new UserError(`${connection} is not a connected service.`, 404);
    }
    await this.markScope(connection, scope === undefined ? [] : [scope]);
    return this.statusOf(connection, found.org, found.connection);
  }

  private async markScope(connection: string, missing: string[]): Promise<void> {
    const before = await this.deps.grants.get(connection);
    if (before === undefined || before.state === "needs-reconnect" || before.state === "revoked") return;
    const name = this.nameOf(before);
    const all = unique([...before.missing, ...missing]);
    // Already known, and the owner was already asked: nothing new to say.
    if (before.state === "insufficient-scope" && all.every((m) => before.missing.includes(m))) return;
    const reason = `${name} asks for more access than you gave${all.length > 0 ? ` (${all.join(", ")})` : ""}. Allow it to continue.`;
    await this.deps.grants.update(connection, (g) => ({
      ...g,
      state: "insufficient-scope",
      stateReason: reason,
      missing: all,
      updatedAt: this.now().toISOString(),
    }));
    this.deps.changed();
    this.deps.attention?.({
      org: before.org,
      key: `connect:${connection}:scope:${all.join(",")}`,
      title: `${name} asks for more access`,
      detail: `${reason} Open Connections, pick ${name} and choose Allow more access.`,
    });
  }

  /** Revokes at the service when it can, deletes the tokens and the connection. */
  async disconnect(
    connection: string,
    meta: CommandMeta,
  ): Promise<{ removed: string; revoked: boolean; note: string }> {
    const found = await this.deps.connections.find(connection);
    if (found?.connection.type === "cli") return this.disconnectCli(connection, found.connection, meta);
    if (found !== undefined && this.isTokenService(found.connection)) {
      return this.disconnectToken(connection, found.connection, meta);
    }
    if (found === undefined || textValue(found.connection, "auth") !== "oauth") {
      throw new UserError(`${connection} is not a connected service.`, 404);
    }
    const grant = await this.deps.grants.get(connection);
    const name = grant === undefined ? found.connection.name : this.nameOf(grant);
    const revoked = grant === undefined ? true : await this.revokeGrant(grant);
    await this.deps.grants.delete(connection);
    await this.deps.connections.remove(connection, "connect.disconnect", meta);
    this.deps.changed();
    this.log(`connect: ${connection} disconnected (${revoked ? "revoked" : "not revoked"})`);
    return {
      removed: connection,
      revoked,
      note: revoked
        ? `${name} is disconnected and its access was revoked.`
        : `${name} is disconnected and majhi deleted its tokens. ${name} could not be asked to revoke them: ${this.whereToRemove(grant, name)}`,
    };
  }

  private whereToRemove(grant: Grant | undefined, name: string): string {
    const page = (grant?.service === undefined ? undefined : this.service(grant.service))?.provider
      ?.accessPage;
    return page === undefined
      ? `remove majhi from the authorized apps in your ${name} account settings.`
      : `remove the app's access at ${page}.`;
  }

  /** Signs the tool out in the workspace's folder, then removes the connection and with it the folder. */
  private async disconnectCli(
    connection: string,
    config: ConnectionConfig,
    meta: CommandMeta,
  ): Promise<{ removed: string; revoked: boolean; note: string }> {
    const tool = cliTool(textValue(config, "tool") ?? "");
    let revoked = false;
    if (tool !== undefined && this.deps.cli?.connected() === true) {
      revoked = (await this.deps.cli.logout({ tool: tool.id, connection }).catch(() => ({ revoked: false })))
        .revoked;
    }
    await this.deps.connections.remove(connection, "connect.disconnect", meta);
    this.cliStates.delete(connection);
    this.deps.changed();
    const name = tool?.name ?? config.name;
    this.log(`connect: ${connection} disconnected (${revoked ? "signed out" : "folder removed"})`);
    return {
      removed: connection,
      revoked,
      note: revoked
        ? `${name} is signed out and this workspace's sign-in folder is removed.`
        : `This workspace's ${name} sign-in folder is removed. majhi could not run ${name}'s own sign-out, so its session may stay valid at the service until it ends.`,
    };
  }

  private async disconnectToken(
    connection: string,
    config: ConnectionConfig,
    meta: CommandMeta,
  ): Promise<{ removed: string; revoked: boolean; note: string }> {
    const service = config.fields?.service ?? "";
    const entry = this.service(service);
    const name = entry?.name ?? config.name;
    const revoked = await this.appSvc.revoke(connection, service).catch(() => false);
    await this.deps.connections.remove(connection, "connect.disconnect", meta);
    this.tokenStates.delete(connection);
    this.deps.changed();
    this.log(`connect: ${connection} disconnected (${revoked ? "revoked" : "not revoked"})`);
    return {
      removed: connection,
      revoked,
      note: revoked
        ? `${name} is disconnected and its token was revoked.`
        : `${name} is disconnected and majhi deleted its tokens. They still work until you remove the app in ${name}'s own settings.`,
    };
  }

  /** The connection was removed some other way: the tokens go too. */
  async removed(connection: string): Promise<void> {
    const grant = await this.deps.grants.get(connection);
    if (grant === undefined) return;
    await this.revokeGrant(grant);
    await this.deps.grants.delete(connection);
  }

  private revokeGrant(grant: Grant): Promise<boolean> {
    this.allowFor(grant);
    return this.forGrant(grant, () => this.revokeGrantInner(grant));
  }

  private async revokeGrantInner(grant: Grant): Promise<boolean> {
    const entry = grant.service === undefined ? undefined : this.service(grant.service);
    const own =
      grant.provider === true && entry?.app !== undefined
        ? await this.deps.apps.get(entry.app, grant.org)
        : undefined;
    const registration =
      grant.provider === true
        ? undefined
        : await this.deps.grants.registration(grant.issuer, this.deps.redirect);
    const client = {
      clientId: grant.clientId,
      clientSecret: own?.clientSecret ?? registration?.clientSecret,
    };
    return this.revokeTokens(grant.revocationEndpoint, client, {
      accessToken: grant.tokens.accessToken,
      refreshToken: grant.tokens.refreshToken,
    });
  }

  private async revokeTokens(
    endpoint: string | undefined,
    client: { clientId: string; clientSecret?: string | undefined },
    tokens: { accessToken: string; refreshToken?: string | undefined },
  ): Promise<boolean> {
    // The refresh token ends the whole grant at most services; the access token follows.
    if (tokens.refreshToken !== undefined) {
      const ok = await revoke(
        endpoint,
        client,
        { value: tokens.refreshToken, hint: "refresh_token" },
        this.fetchFn,
      );
      await revoke(endpoint, client, { value: tokens.accessToken, hint: "access_token" }, this.fetchFn);
      return ok;
    }
    return revoke(endpoint, client, { value: tokens.accessToken, hint: "access_token" }, this.fetchFn);
  }

  // -------------------------------------------------------------------------
  // Background renewal

  startSweeper(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Renews tokens that end soon, for connections a session holds, and restarts those sessions at their next turn end. */
  async sweep(): Promise<void> {
    await this.remind();
    for (const connection of await this.deps.grants.connections()) {
      if (this.deps.inUse?.(connection) !== true) continue;
      const before = await this.deps.grants.get(connection);
      if (before === undefined || before.state === "needs-reconnect" || before.state === "revoked") continue;
      try {
        const after = await this.ensureFresh(connection, { skewMs: SWEEP_AHEAD_MS });
        if (after !== undefined && after.tokens.accessToken !== before.tokens.accessToken) {
          this.deps.remount?.(connection);
        }
      } catch (err) {
        if (!(err instanceof Transient)) throw err;
      }
    }
  }

  /** A sign-in with no renewal (LinkedIn's 60 days) says so five days before it ends, once. */
  private async remind(): Promise<void> {
    for (const connection of await this.deps.grants.connections()) {
      const grant = await this.deps.grants.get(connection);
      if (
        grant === undefined ||
        grant.tokens.refreshToken !== undefined ||
        grant.tokens.expiresAt === undefined
      )
        continue;
      if (grant.state === "needs-reconnect" || grant.state === "revoked") continue;
      const left = Date.parse(grant.tokens.expiresAt) - this.now().getTime();
      const key = `connect:${connection}:ends:${grant.tokens.expiresAt}`;
      if (left > REMIND_AHEAD_MS || this.warned.has(key)) continue;
      this.warned.add(key);
      const name = this.nameOf(grant);
      this.deps.attention?.({
        org: grant.org,
        key,
        title: `${name} sign-in ends soon`,
        detail: `${name} gives no renewal, so this sign-in ends on ${grant.tokens.expiresAt.slice(0, 10)}. Open Connections, pick ${name} and choose Reconnect.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Discovery and registration

  private async discover(serverUrl: string, issuer?: string): Promise<Discovered> {
    const cached = issuer === undefined ? undefined : this.discovered.get(issuer);
    if (cached !== undefined && this.now().getTime() - cached.at < 10 * 60_000) return cached.found;
    const discovered = await discover(serverUrl, this.fetchFn).catch((err: unknown) => {
      throw this.asUser(err);
    });
    // A token tied to one product's server is refused by the others (DigitalOcean answers 401 from
    // its API), so a service with products asks for one that is not tied to any of them.
    const found =
      serviceByUrl(serverUrl, this.catalog)?.products === undefined
        ? discovered
        : { ...discovered, resource: undefined };
    this.discovered.set(found.issuer, { at: this.now().getTime(), found });
    return found;
  }

  /** The client for this issuer: the saved registration, else a new one that is saved. */
  private async clientFor(found: Discovered): Promise<ClientIdentity> {
    const saved = await this.deps.grants.registration(found.issuer, this.deps.redirect);
    if (saved !== undefined)
      return { clientId: saved.clientId, clientSecret: saved.clientSecret, via: saved.via };
    let client: ClientIdentity;
    try {
      client = await register(
        found,
        { redirect: this.deps.redirect, clientMetadataUrl: this.deps.clientMetadataUrl },
        this.fetchFn,
      );
    } catch (err) {
      throw this.asUser(err);
    }
    await this.deps.grants.saveRegistration({
      v: 1,
      issuer: found.issuer,
      redirect: this.deps.redirect,
      clientId: client.clientId,
      ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
      via: client.via,
    });
    return client;
  }

  /** The client a grant was made with. */
  private async clientOf(grant: Grant): Promise<ClientIdentity> {
    const saved = await this.deps.grants.registration(grant.issuer, this.deps.redirect);
    return {
      clientId: grant.clientId,
      clientSecret: saved?.clientId === grant.clientId ? saved.clientSecret : undefined,
      via: saved?.via ?? "dcr",
    };
  }

  private asUser(err: unknown): UserError {
    return new UserError(err instanceof ConnectError ? err.message : "Could not start the sign-in.", 400);
  }

  private scopesFor(entry: ServiceEntry, access: ConnectAccess): string[] {
    const wanted = scopesAt(entry, access);
    const names = wanted.flatMap((s) => s.oauth ?? []);
    // Without published scope names for every part, the service decides what to offer.
    const complete = wanted.every((s) => s.oauth !== undefined);
    return complete ? unique(names) : [];
  }

  private view(flow: Flow): ConnectFlowView {
    return {
      flow: flow.id,
      org: flow.org,
      service: flow.service.id,
      serviceName: flow.service.name,
      ...(flow.state === "connected" || flow.reconnect || flow.test !== undefined
        ? { connection: flow.connection }
        : {}),
      state: flow.state,
      message: flow.message,
      ...(flow.url === undefined ? {} : { url: flow.url }),
      ...(flow.code === undefined ? {} : { code: flow.code }),
      opened: flow.opened,
      ...(flow.account === undefined ? {} : { account: flow.account }),
      ...(flow.previousAccount === undefined || flow.state !== "confirm-account"
        ? {}
        : { previousAccount: flow.previousAccount }),
      scopes: flow.scopes,
      ...(flow.test === undefined ? {} : { test: flow.test }),
      expiresAt: new Date(flow.expiresAt).toISOString(),
    };
  }
}

/** Typed as the state it is now, not the "checking" it was a moment ago. */
const endedWell = (f: Flow): boolean => f.state === "connected" || f.state === "confirm-account";

const isLive = (f: Flow) => f.state === "waiting" || f.state === "checking" || f.state === "confirm-account";

function isExpired(grant: Grant, now: Date): boolean {
  return grant.tokens.expiresAt !== undefined && Date.parse(grant.tokens.expiresAt) <= now.getTime();
}

function sameIssuer(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function stateWords(state: ConnectState, name: string): string {
  switch (state) {
    case "connected":
      return "Connected.";
    case "needs-reconnect":
      return `${name} needs you to sign in again.`;
    case "insufficient-scope":
      return `${name} needs more access than you gave.`;
    case "revoked":
      return `${name} no longer accepts majhi. Reconnect it.`;
    case "error":
      return `The last check of ${name} failed.`;
  }
}

/**
 * What the owner allowed, in the catalog's plain sentences. When the catalog knows the service's
 * scope names, the widest permission whose names were all granted speaks for them, and a name it
 * does not know is shown as it is. When it does not, the sentences of the access the owner chose
 * stand for what the service decided to grant.
 */
export function scopeLines(
  entry: ServiceEntry | undefined,
  granted: readonly string[],
  access: ConnectAccess,
): ConnectScopeLine[] {
  if (entry === undefined)
    return granted.map((name) => ({ access: "other", sentence: `Permission ${name}.` }));
  const named = entry.scopes.filter((s) => s.oauth !== undefined);
  if (named.length === 0) {
    return scopesAt(entry, access).map((s) => ({ access: s.access, sentence: s.sentence }));
  }
  const covered = named.filter((s) => s.oauth?.every((o) => granted.includes(o)));
  const subsumed = (s: (typeof named)[number]) =>
    covered.some(
      (o) =>
        o !== s &&
        (o.oauth?.length ?? 0) > (s.oauth?.length ?? 0) &&
        s.oauth?.every((n) => o.oauth?.includes(n)),
    );
  const lines: ConnectScopeLine[] = covered
    .filter((s) => !subsumed(s))
    .map((s) => ({ access: s.access, sentence: s.sentence }));
  const known = new Set([...named.flatMap((s) => s.oauth ?? []), ...(entry.provider?.identityScopes ?? [])]);
  for (const name of granted)
    if (!known.has(name)) lines.push({ access: "other", sentence: `Permission ${name}.` });
  return lines;
}

/** Whether a connection is the one this catalog entry makes. */
function isOf(connection: ConnectionConfig, entry: ServiceEntry): boolean {
  if (entry.kind === "cli-login") {
    return connection.type === "cli" && textValue(connection, "tool") === entry.cli;
  }
  if (entry.mcpUrl !== undefined) {
    const same = (a: string | undefined, b: string) => a?.replace(/\/+$/, "") === b.replace(/\/+$/, "");
    return textValue(connection, "auth") === "oauth" && same(textValue(connection, "url"), entry.mcpUrl);
  }
  return connection.type === "api" && textValue(connection, "service") === entry.id;
}

interface IssuerExpectation {
  issuer: string | undefined;
  prefix: boolean;
  /** The provider always sends `iss`, so a missing one is wrong. */
  required: boolean;
}

function issuerExpectation(pending: Pending): IssuerExpectation {
  if (pending.provider !== undefined) {
    const c = pending.provider.config;
    return { issuer: c.issuer, prefix: c.issuerPrefix, required: c.issSent };
  }
  return {
    issuer: pending.found?.issuer,
    prefix: false,
    required:
      (pending.found?.metadata as { authorization_response_iss_parameter_supported?: unknown } | undefined)
        ?.authorization_response_iss_parameter_supported === true,
  };
}

/** True when the callback's `iss` is not the issuer majhi asked, or is missing where it must be there. */
function issuerWrong(iss: string | null, expected: IssuerExpectation): boolean {
  if (iss === null) return expected.required;
  if (expected.issuer === undefined) return false;
  return expected.prefix ? !iss.startsWith(expected.issuer) : !sameIssuer(iss, expected.issuer);
}

function asTokenProbe(probe: ApiProbe): TokenProbe {
  switch (probe.kind) {
    case "ok":
      return { kind: "ok" };
    case "invalid":
      return { kind: "invalid" };
    case "forbidden":
      return probe.disabled === undefined
        ? { kind: "other", status: 403, reason: "" }
        : { kind: "other", status: 403, reason: "", disabled: probe.disabled };
    case "unreachable":
      return { kind: "unreachable" };
  }
}

function revokeAt(found: Discovered | undefined, provider: ServiceProvider | undefined): string | undefined {
  return found === undefined ? provider?.revokeUrl : revocationEndpointOf(found.metadata);
}

/** An error's message, with the token never in it: `refusalReason` masks bearer values. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

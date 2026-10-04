import { randomBytes } from "node:crypto";
import {
  type CommandMeta,
  type ConnectAccess,
  type ConnectCatalog,
  type ConnectFlowState,
  type ConnectFlowView,
  type ConnectionConfig,
  type ConnectionTestResult,
  type ConnectionType,
  type ConnectScopeLine,
  type ConnectStartInput,
  type ConnectState,
  type ConnectStatus,
  cliTool,
  SERVICE_CATALOG,
  type ServiceEntry,
  type ServiceProvider,
  scopesAt,
  serviceById,
  serviceByUrl,
  suggestConnectionId,
  textValue,
} from "@majhi/shared";
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
  /** Lists the tools of the server with a bearer token. Throws with a sentence when it cannot. */
  listTools: (url: string, token: string) => Promise<string[]>;
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
  access: ConnectAccess;
  /** The connection a reconnect is for, or the id a first connect will create. */
  connection: string;
  reconnect: boolean;
  /** The account a reconnect must keep. */
  expected: { id?: string | undefined; label?: string | undefined } | undefined;
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

  private readonly appSvc: AppService;

  constructor(private readonly deps: ConnectDeps) {
    this.appSvc = new AppService({
      apps: deps.apps,
      builtIn: deps.builtInApps,
      githubClientId: deps.githubClientId,
      orgName: deps.orgName,
      redirect: deps.redirect,
      fetch: () => this.fetchFn,
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

  private get fetchFn(): Fetch {
    return this.deps.fetch ?? fetch;
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
    if (connection.type !== "env") return false;
    const id = connection.fields?.service;
    return id !== undefined && this.service(id)?.kind === "api-key";
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
  async start(input: ConnectStartInput, meta: CommandMeta): Promise<ConnectFlowView> {
    this.prune();
    const entry = this.service(input.service);
    if (entry === undefined) throw new UserError(`There is no service ${input.service}.`, 404);
    if (!entry.ready) {
      throw new UserError(`${entry.name} cannot be connected with one click yet. ${entry.note ?? ""}`.trim());
    }
    if (entry.kind === "api-key") {
      throw new UserError(`${entry.name} connects when you save its tokens in its app setup.`, 409);
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
      const taken = all.find((c) => c.org === input.org && isOf(c.connection, entry));
      if (taken !== undefined) {
        throw new UserError(
          `${entry.name} is already connected in ${input.org} as ${taken.id}. Use Reconnect there.`,
          409,
        );
      }
      connection = suggestConnectionId(entry.id, new Set(all.map((c) => c.id)));
    }

    // One attempt per connection: a new click replaces the old one.
    for (const f of this.flows.values()) {
      if (f.connection === connection && f.org === input.org && isLive(f))
        this.end(f, "cancelled", "Replaced by a new attempt.");
    }

    const flow: Flow = {
      id: randomBytes(12).toString("base64url"),
      org: input.org,
      service: entry,
      access: input.access,
      connection,
      reconnect,
      expected,
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
    if (!flow.reconnect) {
      await this.deps.connections
        .create(
          {
            org: flow.org,
            id: flow.connection,
            type: "cli",
            name: entry.name,
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
    flow.test = {
      ok: true,
      detail: `${entry.name} is signed in${identity === undefined ? "" : ` as ${identity}`}.`,
      warnings: [],
      at: this.now().toISOString(),
      durationMs: 0,
    };
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
      await this.finish(flow, pending, code);
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
      service: entry.id,
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
      account: {
        ...(account.id === undefined ? {} : { id: account.id }),
        ...(account.label === undefined ? {} : { label: account.label }),
      },
      connectedAt: now,
      updatedAt: now,
    };
    if (!flow.reconnect) {
      await this.deps.connections.create(
        {
          org: flow.org,
          id: flow.connection,
          ...(entry.mcpUrl === undefined
            ? {
                type: "api" as const,
                name: entry.name,
                description: `${entry.summary}. Runs get a short-lived token in ${provider?.tokenVar ?? "ACCESS_TOKEN"}.`,
                fields: { service: entry.id, auth: "oauth", token_var: provider?.tokenVar ?? "ACCESS_TOKEN" },
              }
            : {
                type: "mcp" as const,
                name: entry.name,
                description: entry.summary,
                fields: { transport: "remote", url, protocol: "http", auth: "oauth" },
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
    this.end(
      flow,
      "connected",
      state === "insufficient-scope"
        ? reason
        : flow.test.ok
          ? `Connected${account.label === undefined ? "" : ` as ${account.label}`}.`
          : `Connected${account.label === undefined ? "" : ` as ${account.label}`}, but the test failed: ${flow.test.detail}`,
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
      if (grant.provider === true) {
        tokens = await this.renewProvider(grant, grant.tokens.refreshToken);
      } else {
        const found = await this.discover(grant.serverUrl, grant.issuer);
        const client = await this.clientOf(grant);
        tokens = await refresh(
          found,
          client,
          { redirect: this.deps.redirect, refreshToken: grant.tokens.refreshToken },
          this.fetchFn,
          () => this.now(),
        );
      }
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
      const result = await this.appSvc.test(found.id, service);
      this.tokenStates.set(found.id, {
        state: result.ok ? "connected" : "error",
        reason: result.ok ? "Connected with its bot token." : result.detail,
      });
      this.deps.changed();
      return result;
    }
    const grant = await this.deps.grants.get(connection);
    if (grant === undefined)
      return this.result(false, "majhi has no sign-in for it. Connect it again.", Date.now());
    return this.testGrant(grant);
  }

  /** A command-line tool's Test: its own who-am-I command, in this workspace's folder. */
  private async testCli(id: string, connection: ConnectionConfig): Promise<ConnectionTestResult> {
    const started = Date.now();
    const tool = cliTool(textValue(connection, "tool") ?? "");
    const host = this.deps.cli;
    if (tool === undefined) return this.result(false, "That tool is not known to majhi.", started);
    if (host === undefined || !host.connected()) {
      return this.result(false, "majhi's helper is not running, so the tool cannot be checked now.", started);
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
      );
    } catch {
      return this.result(false, "majhi's helper did not answer. Try again.", started);
    }
  }

  private async testGrant(first: Grant): Promise<ConnectionTestResult> {
    const started = Date.now();
    let grant: Grant | undefined = first;
    try {
      grant = (await this.ensureFresh(first.connection)) ?? first;
    } catch (err) {
      if (!(err instanceof Transient)) throw err;
    }
    if (grant.state === "needs-reconnect" || grant.state === "revoked") {
      return this.result(false, grant.stateReason || stateWords(grant.state, this.nameOf(grant)), started);
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
      if (grant.state === "needs-reconnect") return this.result(false, grant.stateReason, started);
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
      );
    }
    if (probe.kind === "insufficient-scope") {
      const missing = probe.scope;
      await this.markScope(grant.connection, missing);
      return this.result(
        false,
        `${name} needs more access${missing.length > 0 ? ` (${missing.join(", ")})` : ""}. Reconnect and allow it.`,
        started,
      );
    }
    if (probe.kind === "other") {
      const why = probe.reason === "" ? "" : `: ${probe.reason}`;
      const hint =
        this.service(grant.service ?? "")?.enableHint ??
        `Your account may not have ${name}'s MCP server turned on.`;
      return this.result(
        false,
        `${name} refused majhi's calls (${probe.status}${why}). ${hint} The sign-in is kept.`,
        started,
      );
    }
    if (probe.kind === "slow") {
      return this.result(
        false,
        `${hostOf(grant.serverUrl)} took the call but did not answer in 15 seconds. The sign-in is kept; try again.`,
        started,
      );
    }
    if (probe.kind === "unreachable") {
      return this.result(
        false,
        `majhi could not reach ${hostOf(grant.serverUrl)} just now. The sign-in is kept; try again.`,
        started,
      );
    }
    if (apiOnly) {
      if (grant.state === "error") await this.markState(grant.connection, "connected", "");
      return this.result(
        true,
        `Signed in${identityLabel === undefined ? "" : ` as ${identityLabel}`}.`,
        started,
      );
    }
    try {
      const tools = await this.deps.listTools(grant.serverUrl, grant.tokens.accessToken);
      if (grant.state === "error") await this.markState(grant.connection, "connected", "");
      return this.result(
        true,
        `${tools.length} tool${tools.length === 1 ? "" : "s"}${tools.length > 0 ? `: ${tools.slice(0, 4).join(", ")}${tools.length > 4 ? ", ..." : ""}` : ""}`,
        started,
        tools,
      );
    } catch {
      return this.result(false, `${name} signed majhi in but would not list its tools. Try again.`, started);
    }
  }

  private result(ok: boolean, detail: string, started: number, tools?: string[]): ConnectionTestResult {
    return {
      ok,
      detail,
      ...(tools === undefined ? {} : { tools }),
      warnings: [],
      at: this.now().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
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

  private async revokeGrant(grant: Grant): Promise<boolean> {
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
    const found = await discover(serverUrl, this.fetchFn).catch((err: unknown) => {
      throw this.asUser(err);
    });
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
      ...(flow.state === "connected" || flow.reconnect ? { connection: flow.connection } : {}),
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
    return textValue(connection, "auth") === "oauth" && textValue(connection, "url") === entry.mcpUrl;
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
      return { kind: "other", status: 403, reason: "" };
    case "unreachable":
      return { kind: "unreachable" };
  }
}

function revokeAt(found: Discovered | undefined, provider: ServiceProvider | undefined): string | undefined {
  return found === undefined ? provider?.revokeUrl : revocationEndpointOf(found.metadata);
}

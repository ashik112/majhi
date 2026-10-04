import { randomBytes } from "node:crypto";
import {
  type CommandMeta,
  type ConnectAccess,
  type ConnectCatalog,
  type ConnectFlowState,
  type ConnectFlowView,
  type ConnectionConfig,
  type ConnectionTestResult,
  type ConnectScopeLine,
  type ConnectStartInput,
  type ConnectState,
  type ConnectStatus,
  SERVICE_CATALOG,
  type ServiceEntry,
  serviceById,
  serviceByUrl,
  suggestConnectionId,
  textValue,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
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
  type TokenSet,
} from "./oauth.ts";

/** How long the browser page works. The owner has this long to approve. */
export const FLOW_TTL_MS = 10 * 60_000;
/** An ended attempt stays readable this long, so a screen can show how it ended. */
const ENDED_KEEP_MS = 30 * 60_000;
/** An access token with less than this left is renewed before it is used. */
export const REFRESH_SKEW_MS = 5 * 60_000;
/** The background pass renews tokens of connections in use this long before they end. */
const SWEEP_AHEAD_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** The slice of the connections service that Connect needs. */
export interface ConnectConnections {
  create(
    input: {
      org: string;
      id?: string;
      type: "mcp";
      name: string;
      description?: string;
      fields: Record<string, string>;
    },
    command: string,
    meta: CommandMeta,
  ): Promise<unknown>;
  remove(id: string, command: string, meta: CommandMeta): Promise<unknown>;
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
}

interface Pending {
  /** The `state` parameter the service must send back. */
  state: string;
  verifier: string;
  found: Discovered;
  client: ClientIdentity;
  scope: string | undefined;
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
  private readonly discovered = new Map<string, { at: number; found: Discovered }>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: ConnectDeps) {}

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
      if (textValue(c.connection, "auth") !== "oauth") continue;
      out.push(await this.statusOf(c.id, c.org, c.connection));
    }
    return out;
  }

  private async statusOf(id: string, org: string, connection: ConnectionConfig): Promise<ConnectStatus> {
    const grant = await this.deps.grants.get(id);
    const url = textValue(connection, "url") ?? "";
    const entry =
      (grant?.service === undefined ? undefined : this.service(grant.service)) ??
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
    if (!entry.ready || entry.kind !== "mcp-oauth" || entry.mcpUrl === undefined) {
      throw new UserError(`${entry.name} cannot be connected with one click yet. ${entry.note ?? ""}`.trim());
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
      if (found === undefined || found.org !== input.org || textValue(found.connection, "auth") !== "oauth") {
        throw new UserError(`${input.connection} is not a connected service of ${input.org}.`, 404);
      }
      if (textValue(found.connection, "url") !== entry.mcpUrl) {
        throw new UserError(`${input.connection} is not ${entry.name}.`, 409);
      }
      connection = found.id;
      const grant = await this.deps.grants.get(connection);
      if (grant !== undefined) {
        expected = grant.account;
        // More access: ask for what it already had and what it lacked.
        if (grant.state === "insufficient-scope") requested = unique([...grant.requested, ...grant.missing]);
      }
    } else {
      const taken = all.find((c) => c.org === input.org && textValue(c.connection, "url") === entry.mcpUrl);
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

    const found = await this.discover(entry.mcpUrl);
    const client = await this.clientFor(found);
    const state = randomBytes(24).toString("base64url");
    const scope = requested.length === 0 ? undefined : requested.join(" ");
    let started: { url: string; verifier: string };
    try {
      started = await authorizationUrl(found, client, { redirect: this.deps.redirect, scope, state });
    } catch (err) {
      throw this.asUser(err);
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
      url: started.url,
      opened: false,
      account: undefined,
      previousAccount: expected?.label,
      scopes: [],
      test: undefined,
      pending: { state, verifier: started.verifier, found, client, scope },
      held: undefined,
      expiresAt: this.now().getTime() + FLOW_TTL_MS,
      endedAt: undefined,
      meta,
    };
    this.flows.set(flow.id, flow);
    this.byState.set(state, flow.id);
    flow.opened = this.deps.helperConnected()
      ? await this.deps.openUrl(started.url).catch(() => false)
      : false;
    // The address is shown only when majhi could not open it, so a screenshot never holds a live link.
    if (flow.opened) flow.url = undefined;
    this.log(`connect: waiting for ${entry.id} in ${input.org}`);
    this.deps.changed();
    return this.view(flow);
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
    const issuerSent =
      (pending.found.metadata as { authorization_response_iss_parameter_supported?: unknown })
        .authorization_response_iss_parameter_supported === true;
    if ((iss !== null && !sameIssuer(iss, pending.found.issuer)) || (iss === null && issuerSent)) {
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
    const tokens = await exchange(
      pending.found,
      pending.client,
      { redirect: this.deps.redirect, code, verifier: pending.verifier },
      this.fetchFn,
      () => this.now(),
    );
    const account = await identify(tokens, pending.found.metadata, this.fetchFn);
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
    await this.commit(flow, pending.found, pending.client, tokens, account);
  }

  /** The owner answers a reconnect that signed in as another account. */
  async confirmAccount(id: string, accept: boolean): Promise<ConnectFlowView> {
    const flow = this.flows.get(id);
    if (flow === undefined) throw new UserError("That sign-in attempt is gone. Start again.", 404);
    const held = flow.held;
    if (flow.state !== "confirm-account" || held === undefined) {
      throw new UserError("That sign-in is not waiting for an answer.", 409);
    }
    const found = await this.discover(flow.service.mcpUrl ?? "");
    const client = await this.clientFor(found);
    if (!accept) {
      // The other account's sign-in must not linger at the service.
      await this.revokeTokens(revocationEndpointOf(found.metadata), client, held.tokens);
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
      await this.commit(flow, found, client, held.tokens, held.account);
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
    found: Discovered,
    client: ClientIdentity,
    tokens: TokenSet,
    account: Held["account"],
  ): Promise<void> {
    const entry = flow.service;
    const url = entry.mcpUrl ?? "";
    const probe = await probeToken(url, tokens.accessToken, this.fetchFn);
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
      resource: found.resource,
      issuer: found.issuer,
      authorizationServerUrl: found.authorizationServerUrl,
      ...(revocationEndpointOf(found.metadata) === undefined
        ? {}
        : { revocationEndpoint: revocationEndpointOf(found.metadata) }),
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
          type: "mcp",
          name: entry.name,
          description: entry.summary,
          fields: { transport: "remote", url, protocol: "http", auth: "oauth" },
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
    this.discovered.set(found.issuer, { at: this.now().getTime(), found });
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
      const found = await this.discover(grant.serverUrl, grant.issuer);
      const client = await this.clientOf(grant);
      tokens = await refresh(
        found,
        client,
        { redirect: this.deps.redirect, refreshToken: grant.tokens.refreshToken },
        this.fetchFn,
        () => this.now(),
      );
    } catch (err) {
      if (err instanceof ConnectError && err.kind === "refused") {
        this.log(`connect: ${grant.service ?? connection} needs reconnect`);
        return this.markState(
          connection,
          "needs-reconnect",
          `${this.nameOf(grant)} no longer accepts majhi's sign-in. Reconnect it.`,
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
    const grant = await this.deps.grants.get(connection);
    if (grant === undefined)
      return this.result(false, "majhi has no sign-in for it. Connect it again.", Date.now());
    return this.testGrant(grant);
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
    let probe = await probeToken(grant.serverUrl, grant.tokens.accessToken, this.fetchFn);
    if (probe.kind === "invalid" && grant.tokens.refreshToken !== undefined) {
      // The access token may have been cut short. One forced renewal tells that from a revoked grant.
      try {
        grant = (await this.ensureFresh(grant.connection, { force: true })) ?? grant;
      } catch (err) {
        if (!(err instanceof Transient)) throw err;
      }
      if (grant.state === "needs-reconnect") return this.result(false, grant.stateReason, started);
      probe = await probeToken(grant.serverUrl, grant.tokens.accessToken, this.fetchFn);
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
    if (probe.kind === "unreachable" || probe.kind === "other") {
      return this.result(
        false,
        `majhi could not reach ${hostOf(grant.serverUrl)} just now. The sign-in is kept; try again.`,
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
        : `${name} is disconnected and majhi deleted its tokens. ${name} could not be asked to revoke them: remove majhi from the authorized apps in your ${name} account settings.`,
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
    const registration = await this.deps.grants.registration(grant.issuer, this.deps.redirect);
    const client = { clientId: grant.clientId, clientSecret: registration?.clientSecret };
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
    const wanted = entry.scopes.filter((s) => (access === "read" ? s.access === "read" : true));
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
    return entry.scopes
      .filter((s) => access === "readwrite" || s.access === "read")
      .map((s) => ({ access: s.access, sentence: s.sentence }));
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
  const known = new Set(named.flatMap((s) => s.oauth ?? []));
  for (const name of granted)
    if (!known.has(name)) lines.push({ access: "other", sentence: `Permission ${name}.` });
  return lines;
}

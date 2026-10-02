import {
  type BitbucketCallbackQuery,
  type CommandMeta,
  DEFAULT_GIT_HOST,
  type GitAccount,
  gitAppSetup,
  type MrHost,
  normalizeSshRoute,
  type OAuthGrant,
  type OrgConfig,
  type SignInStart,
  type SignInStatus,
  type SignOut,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import { bitbucketConsumer, clientIdFor, type EffectiveApps } from "./apps.ts";
import { type Flow, type HeldToken, newOAuthState, SignInFlows } from "./flows.ts";
import { type Fetch, HostUnreachable, TokenRefused } from "./http.ts";
import {
  bitbucketAuthorizeUrl,
  bitbucketExchange,
  pollDevice,
  revoke,
  revokePage,
  startDevice,
  type TokenAnswer,
  whoAmI,
} from "./oauth.ts";
import { alsoUsedBy, credentialOf } from "./tokens.ts";

/** GitHub's and GitLab's poll interval when they name none. */
const DEFAULT_INTERVAL_MS = 5_000;
/** `slow_down` adds this to the interval (RFC 8628). */
const SLOW_DOWN_MS = 5_000;
/** How long a Bitbucket authorize link is good for. */
const BROWSER_FLOW_MS = 10 * 60_000;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const nameOf = (ref: string) => ref.replace(/^secret:/, "");

export interface SignInDeps {
  fetch: Fetch;
  now?: () => number;
  /** majhi's address as the browser reaches it (`MAJHI_ORIGIN`). */
  origin: () => string;
  apps: () => Promise<EffectiveApps>;
  readSecret: (name: string) => Promise<string | undefined>;
  /** Opens a page through the host helper. False when the helper is missing or could not open it. */
  openUrl: (url: string) => Promise<boolean>;
  orgs: () => Promise<Record<string, OrgConfig>>;
  saveSecret: (input: { value: string; label: string }) => Promise<{ ref: string }>;
  /** Removes a secret when nothing in majhi.yaml or the agent files names it any more. */
  dropSecret: (ref: string) => Promise<void>;
  /** Public name and email of an account, to fill an org identity that is empty. */
  publicProfile: (host: string, account: string) => Promise<{ name: string; email: string } | undefined>;
  /** Writes one org's git accounts, `mr_tokens` and identity: one config commit. */
  writeOrg: (
    id: string,
    patch: {
      git_accounts: GitAccount[] | null;
      mr_tokens: Partial<Record<MrHost, string>> | null;
      identity?: { name: string; email: string };
    },
    change: { command: string; meta: CommandMeta },
  ) => Promise<void>;
  /** A flow changed state; `ended` when it saved something or ended. Never carries a token. */
  changed: (flow: SignInStatus, ended: boolean) => void;
  /** Waits between polls. Tests replace it. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Signing a workspace in to GitHub, GitLab or Bitbucket. Flows and their state machine live in
 * `SignInFlows`; this drives them: it asks the host for a code, polls it, takes the Bitbucket
 * callback, checks the token with the host's user API, and saves it for the named workspace only.
 * A token is never returned, logged, put in an error or in an event.
 */
export class SignInService {
  readonly flows: SignInFlows;

  constructor(private readonly deps: SignInDeps) {
    this.flows = new SignInFlows(deps.now ?? Date.now, (flow) =>
      deps.changed(flow.status, flow.status.state !== "pending"),
    );
  }

  async start(
    input: { org: string; kind: MrHost; host?: string | undefined },
    meta: CommandMeta,
  ): Promise<SignInStart> {
    const orgs = await this.deps.orgs();
    if (orgs[input.org] === undefined) throw new UserError(`Workspace "${input.org}" does not exist.`, 404);
    const host = input.host ?? DEFAULT_GIT_HOST[input.kind];
    if (input.kind !== "gitlab" && host !== DEFAULT_GIT_HOST[input.kind]) {
      throw new UserError(
        input.kind === "github"
          ? "majhi signs in to github.com only. For GitHub Enterprise, paste a token."
          : "majhi signs in to bitbucket.org only.",
      );
    }
    const apps = await this.deps.apps();
    const origin = this.deps.origin();
    if (input.kind === "bitbucket") {
      if (apps.bitbucket === undefined) {
        return { state: "needs-app", kind: "bitbucket", host, setup: gitAppSetup("bitbucket", host, origin) };
      }
      // The secret must be there before the owner is sent off to allow majhi.
      await bitbucketConsumer(apps, this.deps.readSecret);
      const state = newOAuthState();
      const authorizeUrl = bitbucketAuthorizeUrl(apps.bitbucket.key, state);
      const flow = this.flows.start({
        org: input.org,
        kind: "bitbucket",
        host,
        expiresInMs: BROWSER_FLOW_MS,
        meta,
        secret: { kind: "browser", key: apps.bitbucket.key, state, used: false },
        shown: { authorizeUrl },
      });
      const opened = await this.deps.openUrl(authorizeUrl).catch(() => false);
      return {
        state: "browser",
        signIn: flow.id,
        kind: "bitbucket",
        host,
        authorizeUrl,
        expiresAt: new Date(flow.expiresAt).toISOString(),
        opened,
      };
    }
    const clientId = clientIdFor(apps, input.kind, host);
    if (clientId === undefined) {
      return { state: "needs-app", kind: input.kind, host, setup: gitAppSetup(input.kind, host, origin) };
    }
    let code: Awaited<ReturnType<typeof startDevice>>;
    try {
      code = await startDevice(this.deps.fetch, input.kind, host, clientId);
    } catch (err) {
      if (err instanceof HostUnreachable) throw new UserError(err.message, 409);
      throw err;
    }
    const flow = this.flows.start({
      org: input.org,
      kind: input.kind,
      host,
      expiresInMs: code.expires_in * 1000,
      meta,
      secret: {
        kind: "device",
        clientId,
        deviceCode: code.device_code,
        intervalMs: (code.interval ?? DEFAULT_INTERVAL_MS / 1000) * 1000,
      },
      shown: { userCode: code.user_code, verificationUri: code.verification_uri },
    });
    const opened = await this.deps
      .openUrl(code.verification_uri_complete ?? code.verification_uri)
      .catch(() => false);
    void this.runDevice(flow.id);
    return {
      state: "device",
      signIn: flow.id,
      kind: input.kind,
      host,
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      ...(code.verification_uri_complete === undefined
        ? {}
        : { verificationUriComplete: code.verification_uri_complete }),
      expiresAt: new Date(flow.expiresAt).toISOString(),
      opened,
    };
  }

  poll(id: string): SignInStatus {
    const flow = this.flows.get(id);
    if (flow === undefined) throw new UserError("That sign-in is over. Start again.", 404);
    return flow.status;
  }

  cancel(id: string): SignInStatus {
    const flow = this.flows.get(id);
    if (flow === undefined) throw new UserError("That sign-in is over. Start again.", 404);
    this.flows.cancel(id);
    return flow.status;
  }

  /** Saves a sign-in whose account other workspaces use, after the owner said yes. */
  async confirm(id: string): Promise<SignInStatus> {
    const flow = this.flows.get(id);
    if (flow === undefined) throw new UserError("That sign-in is over. Start again.", 404);
    if (flow.status.state !== "confirm" || flow.held === undefined) {
      throw new UserError("That sign-in is not waiting for a confirm.", 409);
    }
    const { account } = flow.status;
    await this.save(flow, account, flow.held);
    return flow.status;
  }

  /** Ends the Bitbucket flow whose `state` this is. Answers one plain sentence; never the code or a token. */
  async bitbucketCallback(query: BitbucketCallbackQuery): Promise<{ ok: boolean; message: string }> {
    const flow = this.flows.takeState(query.state);
    if (flow === undefined) {
      return { ok: false, message: "This sign-in link is not valid any more. Start again in majhi." };
    }
    if (query.error !== undefined) {
      if (query.error === "access_denied") {
        this.flows.denied(flow.id);
        return { ok: false, message: "You did not allow majhi on Bitbucket. Nothing was saved." };
      }
      this.flows.failed(flow.id, "Bitbucket ended the sign-in.");
      return { ok: false, message: "Bitbucket ended the sign-in. Nothing was saved. Start again in majhi." };
    }
    if (query.code === undefined) {
      this.flows.failed(flow.id, "Bitbucket sent no code.");
      return { ok: false, message: "Bitbucket sent no code. Start again in majhi." };
    }
    let token: TokenAnswer;
    let consumer: { key: string; secret: string };
    try {
      consumer = await bitbucketConsumer(await this.deps.apps(), this.deps.readSecret);
      token = await bitbucketExchange(this.deps.fetch, consumer, query.code);
    } catch (err) {
      const reason = safeReason(err, "Bitbucket did not finish the sign-in.");
      this.flows.failed(flow.id, reason);
      return { ok: false, message: `${reason} Nothing was saved.` };
    }
    await this.finish(flow, token, consumer.key);
    const status = this.flows.get(flow.id)?.status ?? flow.status;
    if (status.state === "done") {
      return { ok: true, message: `Signed in to Bitbucket as ${status.account}. Go back to majhi.` };
    }
    if (status.state === "confirm") {
      return { ok: true, message: `Signed in as ${status.account}. Go back to majhi to confirm.` };
    }
    return {
      ok: false,
      message:
        status.state === "failed"
          ? `${status.reason} Nothing was saved.`
          : "The sign-in ended. Nothing was saved.",
    };
  }

  /**
   * Removes the workspace's token and grant for a host, after revoking it where the host allows it.
   * Keeps the git account and its SSH route. Other workspaces are not touched.
   */
  async signOut(
    input: { org: string; kind: MrHost; host?: string | undefined },
    change: { command: string; meta: CommandMeta },
  ): Promise<SignOut> {
    const orgs = await this.deps.orgs();
    const org = orgs[input.org];
    if (org === undefined) throw new UserError(`Workspace "${input.org}" does not exist.`, 404);
    const host = input.host ?? DEFAULT_GIT_HOST[input.kind];
    const cred = credentialOf(org, input.kind, host);
    const base = { org: input.org, kind: input.kind, host };
    if (cred.tokenRef === undefined) {
      return { ...base, removed: false, revoke: "local" };
    }
    const tokenRef = cred.tokenRef;
    let outcome: SignOut["revoke"] = "local";
    if (cred.oauthRef !== undefined) {
      const token = await this.deps.readSecret(nameOf(tokenRef)).catch(() => undefined);
      const grantText = await this.deps.readSecret(nameOf(cred.oauthRef)).catch(() => undefined);
      const clientId = grantClientId(grantText);
      if (token !== undefined) outcome = await revoke(this.deps.fetch, input.kind, host, token, clientId);
    }
    const accounts = (org.git_accounts ?? []).map((a): GitAccount => {
      if (a.host !== host || a.token !== tokenRef) return a;
      const { token: _token, oauth: _oauth, ...rest } = a;
      return rest;
    });
    const tokens = Object.fromEntries(
      Object.entries(org.mr_tokens ?? {}).filter(([, ref]) => ref !== tokenRef),
    ) as Partial<Record<MrHost, string>>;
    await this.deps.writeOrg(
      input.org,
      {
        git_accounts: accounts.length === 0 ? null : accounts,
        mr_tokens: Object.keys(tokens).length === 0 ? null : tokens,
      },
      change,
    );
    for (const ref of [tokenRef, cred.oauthRef]) {
      if (ref !== undefined) await this.deps.dropSecret(ref).catch(() => undefined);
    }
    return {
      ...base,
      ...(cred.account === undefined ? {} : { account: cred.account }),
      removed: true,
      revoke: outcome,
      ...(outcome === "revoked" ? {} : { revokeUrl: revokePage(input.kind, host) }),
    };
  }

  private async runDevice(id: string): Promise<void> {
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
    for (;;) {
      const before = this.flows.get(id);
      if (before === undefined || before.secret.kind !== "device" || before.status.state !== "pending")
        return;
      await wait(before.secret.intervalMs);
      const flow = this.flows.get(id);
      if (flow === undefined || flow.secret.kind !== "device" || flow.status.state !== "pending") return;
      if (flow.kind === "bitbucket") return;
      const answer = await pollDevice(
        this.deps.fetch,
        flow.kind,
        flow.host,
        flow.secret.clientId,
        flow.secret.deviceCode,
      );
      if (this.flows.get(id)?.status.state !== "pending") return;
      switch (answer.state) {
        case "pending":
          continue;
        case "slow-down":
          flow.secret.intervalMs += SLOW_DOWN_MS;
          continue;
        case "denied":
          this.flows.denied(id);
          return;
        case "expired":
          this.flows.expired(id);
          return;
        case "failed":
          this.flows.failed(id, answer.reason);
          return;
        case "token":
          await this.finish(flow, answer.token, flow.secret.clientId);
          return;
      }
    }
  }

  /** Checks the token with the host, then saves it or asks the owner to confirm a reused account. */
  private async finish(flow: Flow, answer: TokenAnswer, clientId: string): Promise<void> {
    let account: string;
    try {
      account = await whoAmI(this.deps.fetch, flow.kind, flow.host, answer.access_token);
    } catch (err) {
      this.flows.failed(flow.id, safeReason(err, `majhi could not check the account on ${flow.host}.`));
      return;
    }
    const grant: OAuthGrant | undefined =
      flow.kind === "github" || answer.refresh_token === undefined
        ? undefined
        : {
            v: 1,
            kind: flow.kind,
            host: flow.host,
            clientId,
            refreshToken: answer.refresh_token,
            expiresAt: new Date(
              (this.deps.now ?? Date.now)() + (answer.expires_in ?? 7200) * 1000,
            ).toISOString(),
            ...((answer.scope ?? answer.scopes)
              ? { scope: (answer.scope ?? answer.scopes ?? "").slice(0, 500) }
              : {}),
          };
    const held: HeldToken = { token: answer.access_token, ...(grant === undefined ? {} : { grant }) };
    const orgs = await this.deps.orgs();
    const others = alsoUsedBy(orgs, flow.org, flow.host, account);
    if (others.length > 0) {
      this.flows.toConfirm(
        flow.id,
        { account, alsoUsedBy: others, replaced: replacedOf(orgs[flow.org], flow.host, account) },
        held,
      );
      return;
    }
    await this.save(flow, account, held);
  }

  /** Saves the token (and grant) for the flow's org only, then ends the flow as `done`. */
  private async save(flow: Flow, account: string, held: HeldToken): Promise<void> {
    try {
      const orgs = await this.deps.orgs();
      const org = orgs[flow.org];
      if (org === undefined) throw new UserError(`Workspace "${flow.org}" no longer exists.`);
      const token = await this.deps.saveSecret({
        value: held.token,
        label: `${flow.org} ${flow.host} ${account} token`,
      });
      const oauth =
        held.grant === undefined
          ? undefined
          : await this.deps.saveSecret({
              value: JSON.stringify(held.grant),
              label: `${flow.org} ${flow.host} ${account} oauth`,
            });
      const previous = (org.git_accounts ?? []).filter((a) => a.host === flow.host);
      const sameAccount = previous.find((a) => same(a.account, account));
      const ssh = normalizeSshRoute(flow.host, sameAccount?.ssh);
      const entry: GitAccount = {
        host: flow.host,
        account,
        ...(ssh === undefined ? {} : { ssh }),
        token: token.ref,
        ...(oauth === undefined ? {} : { oauth: oauth.ref }),
      };
      const git_accounts = [...(org.git_accounts ?? []).filter((a) => a.host !== flow.host), entry];
      const mr_tokens = { ...(org.mr_tokens ?? {}), [flow.kind]: token.ref };
      const identity =
        org.identity === undefined && flow.kind !== "bitbucket"
          ? await this.deps.publicProfile(flow.host, account).catch(() => undefined)
          : undefined;
      const replaced = replacedOf(org, flow.host, account);
      const others = alsoUsedBy(orgs, flow.org, flow.host, account);
      await this.deps.writeOrg(
        flow.org,
        { git_accounts, mr_tokens, ...(identity === undefined ? {} : { identity }) },
        { command: "git.signIn.start", meta: flow.meta },
      );
      // The tokens these replaced belonged to sign-ins of this org on this host only.
      for (const old of previous) {
        if (old.oauth !== undefined) {
          await this.deps.dropSecret(old.oauth).catch(() => undefined);
          if (old.token !== undefined) await this.deps.dropSecret(old.token).catch(() => undefined);
        }
      }
      this.flows.done(flow.id, { account, alsoUsedBy: others, replaced });
    } catch (err) {
      this.flows.failed(flow.id, safeReason(err, "majhi could not save the sign-in."));
    }
  }
}

/** The account this org used on the host before, when it was another one. */
function replacedOf(org: OrgConfig | undefined, host: string, account: string): string | undefined {
  const before = (org?.git_accounts ?? []).find((a) => a.host === host && !same(a.account, account));
  return before?.account;
}

function grantClientId(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const value = (JSON.parse(text) as { clientId?: unknown }).clientId;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Messages of our own errors are plain sentences without secrets; anything else gets `fallback`. */
function safeReason(err: unknown, fallback: string): string {
  if (err instanceof UserError || err instanceof HostUnreachable || err instanceof TokenRefused)
    return err.message;
  return fallback;
}

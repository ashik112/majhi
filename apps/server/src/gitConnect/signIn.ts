import {
  type CommandMeta,
  type ConnectionFailure,
  DEFAULT_GIT_HOST,
  type GitAccount,
  type GitCli,
  type GitCliLoginResult,
  GLAB_CLIENT_ID,
  type MrHost,
  normalizeSshRoute,
  type OAuthGrant,
  type OrgConfig,
  type SignInStart,
  type SignInStatus,
  type SignInTokenInput,
  type SignOut,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import { HostJobError, HostOfflineError } from "../host/link.ts";
import { clientIdFor, type EffectiveApps } from "./apps.ts";
import { type Flow, type HeldToken, MAX_FLOW_MS, SignInFlows } from "./flows.ts";
import { type Fetch, HostUnreachable, TokenRefused } from "./http.ts";
import { pollDevice, revoke, revokePage, startDevice, type TokenAnswer, whoAmI } from "./oauth.ts";
import { alsoUsedBy, credentialOf } from "./tokens.ts";

/** GitHub's and GitLab's poll interval when they name none. */
const DEFAULT_INTERVAL_MS = 5_000;
/** `slow_down` adds this to the interval (RFC 8628). */
const SLOW_DOWN_MS = 5_000;
/** How long `git.signIn.start` waits for the CLI to print its page before it gives up. */
const CLI_PAGE_TIMEOUT_MS = 30_000;
/** The CLI each host signs in with. */
const CLI_OF = { github: "gh", gitlab: "glab" } as const satisfies Record<"github" | "gitlab", GitCli>;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const nameOf = (ref: string) => ref.replace(/^secret:/, "");

/** The host helper's side of a CLI sign-in. */
export interface CliRunner {
  /** False when the host helper is not connected: there is then no CLI to run. */
  connected(): boolean;
  /**
   * Runs `gh` or `glab auth login --web` for one workspace on the owner's computer. `onPage` gets
   * the page to open (and gh's code) once the CLI printed it. Resolves when the CLI ended.
   */
  login(
    params: { signIn: string; cli: GitCli; org: string; host: string },
    onPage: (page: { url: string; code?: string | undefined }) => void,
  ): Promise<GitCliLoginResult>;
  /** Stops the CLI of that sign-in. */
  cancel(signIn: string): Promise<void>;
}

export interface SignInDeps {
  fetch: Fetch;
  now?: () => number;
  apps: () => Promise<EffectiveApps>;
  /** Runs the host's CLI through the host helper. Undefined: never. */
  cli?: CliRunner | undefined;
  /** How long `start` waits for the CLI's page. Tests shorten it. */
  cliPageTimeoutMs?: number;
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
  /**
   * Throws a `UserError` when majhi must not send a token to this self-hosted host (a private or
   * metadata address the owner did not confirm). Undefined: every host is allowed (tests).
   */
  checkHost?: (host: string, options: { allowPrivate: boolean }) => Promise<void>;
}

/**
 * Signing a workspace in to GitHub, GitLab or Bitbucket. Flows and their state machine live in
 * `SignInFlows`; this drives them: it runs the host's CLI through the host helper (or majhi's own
 * device flow when it has a client ID), takes a pasted token, checks the token with the host's
 * user API, and saves it for the named workspace only. A token is never returned, logged, put in an
 * error or in an event.
 */
export class SignInService {
  readonly flows: SignInFlows;

  constructor(private readonly deps: SignInDeps) {
    this.flows = new SignInFlows(deps.now ?? Date.now, (flow) =>
      deps.changed(flow.status, flow.status.state !== "pending"),
    );
  }

  /**
   * Starts a sign-in. In order: the host's CLI on the owner's computer (gh, glab for gitlab.com),
   * then majhi's own device flow when it has a client ID, else `paste` with the reason.
   */
  async start(
    input: { org: string; kind: MrHost; host?: string | undefined; allowPrivate?: boolean | undefined },
    meta: CommandMeta,
  ): Promise<SignInStart> {
    const host = await this.hostFor(input);
    const paste = (reason: Extract<SignInStart, { state: "paste" }>["reason"]): SignInStart => ({
      state: "paste",
      kind: input.kind,
      host,
      reason,
    });
    if (input.kind === "bitbucket") return paste("bitbucket");
    const kind = input.kind;
    this.stopOpen(input.org, host);
    const cli = this.deps.cli;
    if (host === DEFAULT_GIT_HOST[kind] && cli?.connected() === true) {
      const started = await this.startCli(cli, { org: input.org, kind, host }, meta);
      if (started !== "missing") return started;
    }
    const clientId = clientIdFor(await this.deps.apps(), kind, host);
    if (clientId !== undefined) return this.startDevice({ org: input.org, kind, host }, clientId, meta);
    if (host !== DEFAULT_GIT_HOST[kind]) return paste("self-hosted");
    return paste(cli?.connected() === true ? "no-cli" : "no-helper");
  }

  /**
   * Saves a pasted token for one workspace, after the host said whose it is. Bitbucket takes the
   * Atlassian email with an API token, saved as `email:token`. Answers `done`, `confirm` when other
   * workspaces use the account, or `failed` with a plain reason. Nothing is saved on failure.
   */
  async token(input: SignInTokenInput, meta: CommandMeta): Promise<SignInStatus> {
    const host = await this.hostFor(input);
    const cloud = input.kind === "bitbucket" && host === DEFAULT_GIT_HOST.bitbucket;
    if (cloud && input.email === undefined) {
      throw new UserError("Bitbucket Cloud needs the email of your Atlassian account.");
    }
    // Bitbucket Cloud's API token goes with the Atlassian email; Server's access token stands alone.
    const value = cloud ? `${input.email}:${input.token}` : input.token;
    this.stopOpen(input.org, host);
    const flow = this.flows.start({
      org: input.org,
      kind: input.kind,
      host,
      expiresInMs: MAX_FLOW_MS,
      meta,
      secret: { kind: "paste" },
      shown: {},
    });
    await this.finish(flow, { access_token: value }, "");
    return this.flows.get(flow.id)?.status ?? flow.status;
  }

  /**
   * The host a call means, after checking the workspace and the host. A host other than the public
   * one is a self-hosted server (GitHub Enterprise, GitLab self-managed, Bitbucket Server): it must
   * be a plain host name, and not a private or metadata address unless the owner confirmed it.
   */
  private async hostFor(input: {
    org: string;
    kind: MrHost;
    host?: string | undefined;
    allowPrivate?: boolean | undefined;
  }): Promise<string> {
    const orgs = await this.deps.orgs();
    if (orgs[input.org] === undefined) throw new UserError(`Workspace "${input.org}" does not exist.`, 404);
    const host = input.host ?? DEFAULT_GIT_HOST[input.kind];
    if (host !== DEFAULT_GIT_HOST[input.kind]) {
      await this.deps.checkHost?.(host, { allowPrivate: input.allowPrivate === true });
    }
    return host;
  }

  /** Stops the CLI of every open sign-in of this workspace and host. The flows themselves end on the next start. */
  private stopOpen(org: string, host: string): void {
    for (const flow of this.flows.open()) {
      if (flow.org === org && flow.host === host && flow.secret.kind === "cli") {
        void this.deps.cli?.cancel(flow.id).catch(() => undefined);
      }
    }
  }

  /**
   * Runs the host's CLI and waits for the page it prints. `missing` when the CLI is not installed.
   * Throws a plain sentence when it ends or stalls before showing a page.
   */
  private async startCli(
    cli: CliRunner,
    input: { org: string; kind: "github" | "gitlab"; host: string },
    meta: CommandMeta,
  ): Promise<SignInStart | "missing"> {
    const name = CLI_OF[input.kind];
    const flow = this.flows.start({
      org: input.org,
      kind: input.kind,
      host: input.host,
      expiresInMs: MAX_FLOW_MS,
      meta,
      secret: { kind: "cli", cli: name },
      shown: {},
    });
    let showPage: (page: { url: string; code?: string | undefined }) => void = () => undefined;
    const page = new Promise<{ url: string; code?: string | undefined }>((resolve) => {
      showPage = resolve;
    });
    const job = cli.login({ signIn: flow.id, cli: name, org: input.org, host: input.host }, (p) =>
      showPage(p),
    );
    void job.then(
      (result) => this.cliEnded(flow.id, result),
      (err: unknown) => this.flows.failed(flow.id, safeReason(err, `${name} did not finish the sign-in.`)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      page.then((p) => ({ kind: "page" as const, page: p })),
      job.then(
        (result) => ({ kind: "ended" as const, result }),
        (err: unknown) => ({ kind: "error" as const, err }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "timeout" }),
          this.deps.cliPageTimeoutMs ?? CLI_PAGE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (first.kind === "ended" && first.result.state === "missing") {
      this.flows.cancel(flow.id);
      return "missing";
    }
    if (first.kind === "error") {
      if (first.err instanceof HostOfflineError) {
        this.flows.cancel(flow.id);
        return "missing";
      }
      throw new UserError(safeReason(first.err, `${name} did not start the sign-in. Try again.`), 409);
    }
    if (first.kind === "timeout") {
      void cli.cancel(flow.id).catch(() => undefined);
      this.flows.failed(flow.id, `${name} did not show a sign-in page.`);
      throw new UserError(`${name} did not show a sign-in page. Try again, or paste a token instead.`, 409);
    }
    const expiresAt = new Date(flow.expiresAt).toISOString();
    if (first.kind === "ended") {
      // Ended before it printed a page: the flow already shows how it went.
      return {
        state: "browser",
        signIn: flow.id,
        kind: input.kind,
        host: input.host,
        authorizeUrl: `https://${input.host}/`,
        expiresAt,
        opened: false,
      };
    }
    const { url, code } = first.page;
    if (code !== undefined) this.flows.show(flow.id, { userCode: code, verificationUri: url });
    else this.flows.show(flow.id, { authorizeUrl: url });
    const opened = await this.deps.openUrl(url).catch(() => false);
    return code !== undefined
      ? {
          state: "device",
          signIn: flow.id,
          kind: input.kind,
          host: input.host,
          userCode: code,
          verificationUri: url,
          expiresAt,
          opened,
        }
      : {
          state: "browser",
          signIn: flow.id,
          kind: input.kind,
          host: input.host,
          authorizeUrl: url,
          expiresAt,
          opened,
        };
  }

  /** The CLI ended: save its token, or end the flow the way it ended. */
  private async cliEnded(id: string, result: GitCliLoginResult): Promise<void> {
    const flow = this.flows.get(id);
    if (flow === undefined || flow.status.state !== "pending") return;
    if (result.state === "missing") return;
    if (result.state === "cancelled") {
      this.flows.cancel(id);
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    const expiresIn =
      result.expiresAt === undefined
        ? undefined
        : Math.max(60, Math.round((Date.parse(result.expiresAt) - now) / 1000));
    await this.finish(
      flow,
      {
        access_token: result.token,
        ...(result.refreshToken === undefined ? {} : { refresh_token: result.refreshToken }),
        ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      },
      // glab's own OAuth app made the token, so refreshing needs its client ID.
      flow.kind === "gitlab" ? GLAB_CLIENT_ID : "",
    );
  }

  /** majhi's own device flow, with a client ID from `git_apps` or `BUILT_IN_OAUTH_APPS`. */
  private async startDevice(
    input: { org: string; kind: "github" | "gitlab"; host: string },
    clientId: string,
    meta: CommandMeta,
  ): Promise<SignInStart> {
    let code: Awaited<ReturnType<typeof startDevice>>;
    try {
      code = await startDevice(this.deps.fetch, input.kind, input.host, clientId);
    } catch (err) {
      if (err instanceof HostUnreachable) throw new UserError(err.message, 409);
      throw err;
    }
    const flow = this.flows.start({
      org: input.org,
      kind: input.kind,
      host: input.host,
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
      host: input.host,
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

  /** Ends a pending or confirming flow, and stops its CLI. Nothing is saved. */
  cancel(id: string): SignInStatus {
    const flow = this.flows.get(id);
    if (flow === undefined) throw new UserError("That sign-in is over. Start again.", 404);
    const wasOpen = flow.status.state === "pending" || flow.status.state === "confirm";
    this.flows.cancel(id);
    if (wasOpen && flow.secret.kind === "cli") void this.deps.cli?.cancel(id).catch(() => undefined);
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
    const token = await this.deps.readSecret(nameOf(tokenRef)).catch(() => undefined);
    if (cred.oauthRef !== undefined) {
      const grantText = await this.deps.readSecret(nameOf(cred.oauthRef)).catch(() => undefined);
      const clientId = grantClientId(grantText);
      if (token !== undefined) outcome = await revoke(this.deps.fetch, input.kind, host, token, clientId);
    }
    // A browser sign-in shows on the host's authorized apps page; a pasted token on its tokens page.
    const viaApp = input.kind === "github" ? token?.startsWith("gho_") === true : cred.oauthRef !== undefined;
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
      ...(outcome === "revoked" ? {} : { revokeUrl: revokePage(input.kind, host, viaApp) }),
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
      // The host's status decided: a 401 or 403 is a refused token, anything else a host that did not answer.
      const failure: ConnectionFailure =
        err instanceof TokenRefused || err instanceof HostUnreachable
          ? {
              reason: err.reason,
              fix:
                err instanceof TokenRefused
                  ? `${flow.host} did not accept the token. Make a new one and paste it.`
                  : `${flow.host} did not answer as ${flow.kind}. Check the host, then try again.`,
            }
          : { reason: "unexpected" };
      this.flows.failed(
        flow.id,
        safeReason(err, `majhi could not check the account on ${flow.host}.`),
        failure,
      );
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

/**
 * Messages of our own errors are plain sentences without secrets, and so are the host helper's
 * (it never puts a CLI's output or a token in one); anything else gets `fallback`.
 */
function safeReason(err: unknown, fallback: string): string {
  if (
    err instanceof UserError ||
    err instanceof HostUnreachable ||
    err instanceof TokenRefused ||
    err instanceof HostJobError ||
    err instanceof HostOfflineError
  )
    return err.message;
  return fallback;
}

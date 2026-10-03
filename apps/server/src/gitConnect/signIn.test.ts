import type { GitAccount, GitCliLoginResult, MrHost, OrgConfig, SignInStatus } from "@majhi/shared";
import { GLAB_CLIENT_ID } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { HostJobError } from "../host/link.ts";
import { type FakeGitHosts, fakeGitHosts } from "../testing/gitHosts.ts";
import type { EffectiveApps } from "./apps.ts";
import { type CliRunner, SignInService } from "./signIn.ts";

const GH_TOKEN = "gho_SecretAcmeToken1234567890";
const GL_TOKEN = "glpat_SecretGitLabToken987654";
const GL_REFRESH = "glrt_SecretRefresh111";
const BB_TOKEN = "ATATTSecretBitbucketToken55";
const BB_EMAIL = "dev@acme.test";
const SECRETS = [GH_TOKEN, GL_TOKEN, GL_REFRESH, BB_TOKEN, "dev-code-1"];

/**
 * A fake host helper running `gh` or `glab`: it shows the page at once (or never, or ends first),
 * then waits until the test ends the CLI with `finish`.
 */
function fakeCli(
  options: {
    connected?: boolean;
    page?: { url: string; code?: string } | "none";
    ends?: GitCliLoginResult | Error;
  } = {},
) {
  const calls: Array<{ signIn: string; cli: string; org: string; host: string }> = [];
  const cancelled: string[] = [];
  let finish: (result: GitCliLoginResult | Error) => void = () => undefined;
  const runner: CliRunner = {
    connected: () => options.connected ?? true,
    login: (params, onPage) => {
      calls.push(params);
      return new Promise<GitCliLoginResult>((resolve, reject) => {
        finish = (r) => (r instanceof Error ? reject(r) : resolve(r));
        if (options.ends !== undefined) {
          finish(options.ends);
          return;
        }
        const page = options.page ?? { url: "https://github.com/login/device", code: "AB12-CD34" };
        if (page !== "none") setImmediate(() => onPage(page));
      });
    },
    cancel: async (signIn) => {
      cancelled.push(signIn);
      finish({ state: "cancelled" });
    },
  };
  return { runner, calls, cancelled, finish: (r: GitCliLoginResult | Error) => finish(r) };
}

interface Setup {
  service: SignInService;
  hosts: FakeGitHosts;
  orgs: Record<string, OrgConfig>;
  secrets: Map<string, string>;
  events: SignInStatus[];
  waits: number[];
  outputs: unknown[];
  dropped: string[];
  opened: string[];
}

function setup(
  options: {
    apps?: Partial<EffectiveApps>;
    noGithub?: boolean;
    orgs?: Record<string, OrgConfig>;
    now?: () => number;
    cli?: CliRunner;
  } = {},
): Setup {
  const hosts = fakeGitHosts();
  const orgs: Record<string, OrgConfig> = options.orgs ?? {
    private: { name: "Private" },
    acme: { name: "Acme" },
    globex: { name: "Globex" },
  };
  const secrets = new Map<string, string>();
  const events: SignInStatus[] = [];
  const waits: number[] = [];
  const dropped: string[] = [];
  const opened: string[] = [];
  let n = 0;
  const service = new SignInService({
    fetch: hosts.fetch,
    ...(options.now === undefined ? {} : { now: options.now }),
    cli: options.cli,
    cliPageTimeoutMs: 200,
    apps: async () => ({
      ...(options.noGithub === true ? {} : { github: { clientId: "Ov23liAcmeExample01", builtIn: false } }),
      gitlab: { "gitlab.com": { clientId: "0123456789abcdef", builtIn: false } },
      ...options.apps,
    }),
    readSecret: async (name) => secrets.get(name),
    openUrl: async (url) => {
      opened.push(url);
      return false;
    },
    orgs: async () => structuredClone(orgs),
    saveSecret: async ({ value }) => {
      n += 1;
      secrets.set(`s${n}`, value);
      return { ref: `secret:s${n}` };
    },
    dropSecret: async (ref) => {
      dropped.push(ref);
      secrets.delete(ref.replace(/^secret:/, ""));
    },
    publicProfile: async () => undefined,
    writeOrg: async (id, patch) => {
      const org = orgs[id];
      if (org === undefined) throw new UserError("no org");
      if (patch.git_accounts === null) delete org.git_accounts;
      else org.git_accounts = patch.git_accounts;
      if (patch.mr_tokens === null) delete org.mr_tokens;
      else org.mr_tokens = patch.mr_tokens;
      if (patch.identity !== undefined) org.identity = patch.identity;
    },
    changed: (status) => events.push(structuredClone(status)),
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  return { service, hosts, orgs, secrets, events, waits, outputs: [], dropped, opened };
}

/** Lets the background poll loop run until the flow leaves `pending`. */
async function settle(s: Setup, id: string): Promise<SignInStatus> {
  for (let i = 0; i < 200; i++) {
    const status = s.service.poll(id);
    if (status.state !== "pending") return status;
    await new Promise((r) => setImmediate(r));
  }
  return s.service.poll(id);
}

function githubDevice(s: Setup, polls: Array<{ status?: number; json: unknown }>, login = "octo-acme"): void {
  s.hosts.on("POST https://github.com/login/device/code", () => ({
    json: {
      device_code: "dev-code-1",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    },
  }));
  let i = 0;
  s.hosts.on("POST https://github.com/login/oauth/access_token", () => {
    const answer = polls[Math.min(i, polls.length - 1)] ?? { json: { error: "authorization_pending" } };
    i += 1;
    return answer;
  });
  s.hosts.on("GET https://api.github.com/user", (req) =>
    req.headers.authorization === `Bearer ${GH_TOKEN}` ? { json: { login } } : { status: 401, json: {} },
  );
}

/** Nothing a flow showed, announced or answered holds a token, a refresh token or a code. */
function expectNoSecrets(s: Setup, extra: unknown[] = []): void {
  const text = JSON.stringify([s.events, s.outputs, extra]);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("GitHub device flow", () => {
  it("polls, slows down when told, checks the user and saves the token for the named workspace only", async () => {
    const s = setup();
    githubDevice(s, [
      { json: { error: "authorization_pending" } },
      { json: { error: "slow_down" } },
      { json: { access_token: GH_TOKEN, token_type: "bearer", scope: "repo,read:org,workflow" } },
    ]);
    const start = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    s.outputs.push(start);
    expect(start).toMatchObject({
      state: "device",
      userCode: "WDJB-MJHT",
      opened: false,
      host: "github.com",
    });
    expect(s.opened).toEqual(["https://github.com/login/device"]);
    if (start.state !== "device") throw new Error("not a device flow");
    const done = await settle(s, start.signIn);
    s.outputs.push(done);
    expect(done).toEqual({
      state: "done",
      signIn: start.signIn,
      org: "acme",
      kind: "github",
      host: "github.com",
      account: "octo-acme",
      alsoUsedBy: [],
    });
    // 5 s, 5 s, then 10 s after slow_down.
    expect(s.waits).toEqual([5000, 5000, 10000]);
    const scope = s.hosts.requests.find((r) => r.url === "https://github.com/login/device/code")?.form.scope;
    expect(scope).toBe("repo read:org workflow");
    // Saved for acme only, as the git account's token and mr_tokens.github; GitHub has no grant.
    expect(s.orgs.acme?.git_accounts).toEqual([
      { host: "github.com", account: "octo-acme", token: "secret:s1" },
    ]);
    expect(s.orgs.acme?.mr_tokens).toEqual({ github: "secret:s1" });
    expect(s.orgs.globex?.git_accounts).toBeUndefined();
    expect(s.secrets.get("s1")).toBe(GH_TOKEN);
    // The token never left in a URL.
    for (const r of s.hosts.requests) expect(r.url).not.toContain(GH_TOKEN);
    expectNoSecrets(s);
  });

  it("ends as denied or expired and saves nothing", async () => {
    for (const [error, state] of [
      ["access_denied", "denied"],
      ["expired_token", "expired"],
    ] as const) {
      const s = setup();
      githubDevice(s, [{ json: { error } }]);
      const start = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
      if (start.state !== "device") throw new Error("not a device flow");
      expect((await settle(s, start.signIn)).state).toBe(state);
      expect(s.secrets.size).toBe(0);
      expect(s.orgs.acme?.git_accounts).toBeUndefined();
    }
  });

  it("a cancelled flow never saves, even when the host answers later", async () => {
    const s = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    githubDevice(s, [{ json: { access_token: GH_TOKEN } }]);
    s.hosts.on("POST https://github.com/login/oauth/access_token", async () => {
      await gate;
      return { json: { access_token: GH_TOKEN } };
    });
    const start = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    if (start.state !== "device") throw new Error("not a device flow");
    await new Promise((r) => setImmediate(r));
    expect(s.service.cancel(start.signIn).state).toBe("cancelled");
    release();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(s.service.poll(start.signIn).state).toBe("cancelled");
    expect(s.orgs.acme?.git_accounts).toBeUndefined();
    // A cancelled flow cannot be confirmed or moved on.
    await expect(s.service.confirm(start.signIn)).rejects.toThrow(/not waiting/);
  });

  it("a second start for the same workspace and host cancels the first", async () => {
    const s = setup();
    githubDevice(s, [{ json: { error: "authorization_pending" } }]);
    const first = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    const second = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    if (first.state !== "device" || second.state !== "device") throw new Error("not device flows");
    expect(s.service.poll(first.signIn).state).toBe("cancelled");
    expect(s.service.poll(second.signIn).state).toBe("pending");
    s.service.cancel(second.signIn);
  });

  it("asks to confirm an account another workspace uses, and saves only after the confirm", async () => {
    const s = setup({
      orgs: {
        private: { name: "Private" },
        acme: { name: "Acme", git_accounts: [{ host: "github.com", account: "old-acme" }] },
        globex: {
          name: "Globex",
          git_accounts: [{ host: "github.com", account: "Octo-Acme" } as GitAccount],
        },
      },
    });
    githubDevice(s, [{ json: { access_token: GH_TOKEN } }]);
    const start = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    if (start.state !== "device") throw new Error("not a device flow");
    const asked = await settle(s, start.signIn);
    s.outputs.push(asked);
    expect(asked).toMatchObject({
      state: "confirm",
      account: "octo-acme",
      alsoUsedBy: ["globex"],
      replaced: "old-acme",
    });
    expect(s.orgs.acme?.git_accounts).toEqual([{ host: "github.com", account: "old-acme" }]);
    expect(s.secrets.size).toBe(0);
    const done = await s.service.confirm(start.signIn);
    s.outputs.push(done);
    expect(done).toMatchObject({
      state: "done",
      account: "octo-acme",
      alsoUsedBy: ["globex"],
      replaced: "old-acme",
    });
    // The previous account on that host is replaced; globex is untouched.
    expect(s.orgs.acme?.git_accounts).toEqual([
      { host: "github.com", account: "octo-acme", token: "secret:s1" },
    ]);
    expect(s.orgs.globex?.git_accounts).toEqual([{ host: "github.com", account: "Octo-Acme" }]);
    expect(s.orgs.globex?.mr_tokens).toBeUndefined();
    expectNoSecrets(s);
  });

  it("answers paste when there is no CLI and no app, saying why", async () => {
    const offline = setup({ noGithub: true });
    expect(
      await offline.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } }),
    ).toEqual({
      state: "paste",
      kind: "github",
      host: "github.com",
      reason: "no-helper",
    });
    const noGh = setup({ noGithub: true, cli: fakeCli({ ends: { state: "missing" } }).runner });
    expect(
      await noGh.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } }),
    ).toMatchObject({
      state: "paste",
      reason: "no-cli",
    });
    expect(offline.hosts.requests).toEqual([]);
  });

  it("fails with a plain reason when the user check fails, and the reason holds no token", async () => {
    const s = setup();
    githubDevice(s, [{ json: { access_token: GH_TOKEN } }]);
    s.hosts.on("GET https://api.github.com/user", () => ({
      status: 500,
      json: { message: `boom ${GH_TOKEN}` },
    }));
    const start = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    if (start.state !== "device") throw new Error("not a device flow");
    const failed = await settle(s, start.signIn);
    s.outputs.push(failed);
    expect(failed).toMatchObject({
      state: "failed",
      reason: "majhi could not check the account on github.com. Try again.",
    });
    expectNoSecrets(s);
  });
});

describe("GitLab device grant", () => {
  it("saves the token and a grant with the refresh token, and passes the prefilled page through", async () => {
    const s = setup({ now: () => Date.parse("2026-10-02T10:00:00Z") });
    s.hosts.on("POST https://gitlab.com/oauth/authorize_device", (req) => {
      expect(req.form).toEqual({ client_id: "0123456789abcdef", scope: "api" });
      return {
        json: {
          device_code: "dev-code-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://gitlab.com/oauth/device",
          verification_uri_complete: "https://gitlab.com/oauth/device?user_code=ABCD-EFGH",
          expires_in: 300,
          interval: 5,
        },
      };
    });
    s.hosts.on("POST https://gitlab.com/oauth/token", () => ({
      json: { access_token: GL_TOKEN, refresh_token: GL_REFRESH, expires_in: 7200, scope: "api" },
    }));
    s.hosts.on("GET https://gitlab.com/api/v4/user", () => ({ json: { username: "acme-dev" } }));
    const start = await s.service.start({ org: "acme", kind: "gitlab" }, { actor: { kind: "owner" } });
    s.outputs.push(start);
    expect(start).toMatchObject({
      state: "device",
      verificationUriComplete: "https://gitlab.com/oauth/device?user_code=ABCD-EFGH",
    });
    expect(s.opened).toEqual(["https://gitlab.com/oauth/device?user_code=ABCD-EFGH"]);
    if (start.state !== "device") return;
    expect((await settle(s, start.signIn)).state).toBe("done");
    expect(s.orgs.acme?.git_accounts).toEqual([
      { host: "gitlab.com", account: "acme-dev", token: "secret:s1", oauth: "secret:s2" },
    ]);
    expect(JSON.parse(s.secrets.get("s2") ?? "")).toEqual({
      v: 1,
      kind: "gitlab",
      host: "gitlab.com",
      clientId: "0123456789abcdef",
      refreshToken: GL_REFRESH,
      expiresAt: "2026-10-02T12:00:00.000Z",
      scope: "api",
    });
    expectNoSecrets(s);
  });

  it("tells an old self-hosted GitLab plainly, and asks for a token on a host without an app", async () => {
    const s = setup({
      apps: { gitlab: { "gitlab.acme.test": { clientId: "fedcba9876543210", builtIn: false } } },
    });
    s.hosts.on("POST https://gitlab.acme.test/oauth/authorize_device", () => ({ status: 404, json: {} }));
    await expect(
      s.service.start(
        { org: "acme", kind: "gitlab", host: "gitlab.acme.test" },
        { actor: { kind: "owner" } },
      ),
    ).rejects.toThrow(/needs GitLab 17\.3 or later/);
    const other = await s.service.start(
      { org: "acme", kind: "gitlab", host: "gitlab.globex.test" },
      { actor: { kind: "owner" } },
    );
    expect(other).toEqual({
      state: "paste",
      kind: "gitlab",
      host: "gitlab.globex.test",
      reason: "self-hosted",
    });
  });
});

describe("CLI sign-in through the host helper", () => {
  it("gh: shows its code, opens its page, then saves the token for the named workspace only", async () => {
    const cli = fakeCli();
    const s = setup({ noGithub: true, cli: cli.runner });
    s.hosts.on("GET https://api.github.com/user", (req) =>
      req.headers.authorization === `Bearer ${GH_TOKEN}`
        ? { json: { login: "octo-acme" } }
        : { status: 401, json: {} },
    );
    const start = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    s.outputs.push(start);
    expect(start).toMatchObject({
      state: "device",
      kind: "github",
      host: "github.com",
      userCode: "AB12-CD34",
      verificationUri: "https://github.com/login/device",
    });
    if (start.state !== "device") return;
    expect(cli.calls).toEqual([{ signIn: start.signIn, cli: "gh", org: "acme", host: "github.com" }]);
    expect(s.opened).toEqual(["https://github.com/login/device"]);
    expect(s.service.poll(start.signIn)).toMatchObject({ state: "pending", userCode: "AB12-CD34" });

    cli.finish({ state: "done", token: GH_TOKEN });
    const done = await settle(s, start.signIn);
    s.outputs.push(done);
    expect(done).toMatchObject({ state: "done", org: "acme", account: "octo-acme", alsoUsedBy: [] });
    expect(s.orgs.acme?.git_accounts).toEqual([
      { host: "github.com", account: "octo-acme", token: "secret:s1" },
    ]);
    expect(s.orgs.acme?.mr_tokens).toEqual({ github: "secret:s1" });
    expect(s.orgs.globex?.git_accounts).toBeUndefined();
    expect(s.orgs.globex?.mr_tokens).toBeUndefined();
    expect(s.secrets.get("s1")).toBe(GH_TOKEN);
    expectNoSecrets(s);
  });

  it("glab: opens its page and saves a grant refreshed with glab's client ID", async () => {
    const cli = fakeCli({ page: { url: "https://gitlab.com/oauth/authorize?client_id=x&state=y" } });
    const s = setup({ cli: cli.runner, now: () => Date.parse("2026-10-03T10:00:00Z") });
    s.hosts.on("GET https://gitlab.com/api/v4/user", () => ({ json: { username: "acme-dev" } }));
    const start = await s.service.start({ org: "acme", kind: "gitlab" }, { actor: { kind: "owner" } });
    expect(start).toMatchObject({
      state: "browser",
      kind: "gitlab",
      authorizeUrl: "https://gitlab.com/oauth/authorize?client_id=x&state=y",
    });
    if (start.state !== "browser") return;
    expect(cli.calls[0]).toMatchObject({ cli: "glab", org: "acme", host: "gitlab.com" });
    cli.finish({
      state: "done",
      token: GL_TOKEN,
      refreshToken: GL_REFRESH,
      expiresAt: "2026-10-03T12:00:00.000Z",
    });
    expect((await settle(s, start.signIn)).state).toBe("done");
    expect(s.orgs.acme?.git_accounts).toEqual([
      { host: "gitlab.com", account: "acme-dev", token: "secret:s1", oauth: "secret:s2" },
    ]);
    expect(JSON.parse(s.secrets.get("s2") ?? "")).toEqual({
      v: 1,
      kind: "gitlab",
      host: "gitlab.com",
      clientId: GLAB_CLIENT_ID,
      refreshToken: GL_REFRESH,
      expiresAt: "2026-10-03T12:00:00.000Z",
    });
    // No device flow was asked of GitLab: glab did the sign-in.
    expect(s.hosts.requests.map((r) => r.url)).toEqual(["https://gitlab.com/api/v4/user"]);
    expectNoSecrets(s);
  });

  it("cancel stops the CLI and saves nothing, even when it ends with a token", async () => {
    const cli = fakeCli();
    const s = setup({ noGithub: true, cli: cli.runner });
    const start = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    if (start.state !== "device") throw new Error("not a device start");
    expect(s.service.cancel(start.signIn).state).toBe("cancelled");
    expect(cli.cancelled).toEqual([start.signIn]);
    cli.finish({ state: "done", token: GH_TOKEN });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(s.service.poll(start.signIn).state).toBe("cancelled");
    expect(s.orgs.acme?.git_accounts).toBeUndefined();
    expect(s.secrets.size).toBe(0);
  });

  it("a new start stops the CLI of the open one", async () => {
    const cli = fakeCli();
    const s = setup({ noGithub: true, cli: cli.runner });
    const first = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    if (first.state !== "device") throw new Error("not a device start");
    await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    expect(cli.cancelled).toContain(first.signIn);
    expect(s.service.poll(first.signIn).state).toBe("cancelled");
  });

  it("a missing gh falls back to majhi's device flow when it has an app", async () => {
    const s = setup({ cli: fakeCli({ ends: { state: "missing" } }).runner });
    githubDevice(s, [{ json: { error: "authorization_pending" } }]);
    const start = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    expect(start).toMatchObject({ state: "device", userCode: "WDJB-MJHT" });
    if (start.state === "device") s.service.cancel(start.signIn);
  });

  it("a CLI that fails says so plainly and never echoes what it printed", async () => {
    const s = setup({
      noGithub: true,
      cli: fakeCli({ ends: new Error(`gh said: token ${GH_TOKEN} is bad`) }).runner,
    });
    const err = await s.service
      .start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } })
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe("gh did not start the sign-in. Try again.");
    const helper = setup({
      noGithub: true,
      cli: fakeCli({ ends: new HostJobError("The sign-in was refused on GitHub. Nothing was saved.") })
        .runner,
    });
    await expect(
      helper.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } }),
    ).rejects.toThrow("The sign-in was refused on GitHub. Nothing was saved.");
    expectNoSecrets(s, [err]);
  });

  it("a CLI that shows no page in time is stopped", async () => {
    const cli = fakeCli({ page: "none" });
    const s = setup({ noGithub: true, cli: cli.runner });
    await expect(
      s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } }),
    ).rejects.toThrow("gh did not show a sign-in page. Try again, or paste a token instead.");
    expect(cli.cancelled).toHaveLength(1);
  });
});

describe("Pasted tokens", () => {
  function bitbucket(s: Setup): void {
    const good = `Basic ${Buffer.from(`${BB_EMAIL}:${BB_TOKEN}`).toString("base64")}`;
    s.hosts.on("GET https://api.bitbucket.org/2.0/user", (req) =>
      req.headers.authorization === good ? { json: { username: "acme-bb" } } : { status: 401, json: {} },
    );
  }

  it("Bitbucket always asks for an API token: no admin, no consumer", async () => {
    const s = setup();
    expect(await s.service.start({ org: "acme", kind: "bitbucket" }, { actor: { kind: "owner" } })).toEqual({
      state: "paste",
      kind: "bitbucket",
      host: "bitbucket.org",
      reason: "bitbucket",
    });
    expect(s.hosts.requests).toEqual([]);
  });

  it("checks the Atlassian email and API token with Bitbucket, then saves them for the named workspace", async () => {
    const s = setup();
    bitbucket(s);
    const done = await s.service.token(
      { org: "acme", kind: "bitbucket", token: BB_TOKEN, email: BB_EMAIL },
      { actor: { kind: "owner" } },
    );
    s.outputs.push(done);
    expect(done).toMatchObject({ state: "done", org: "acme", kind: "bitbucket", account: "acme-bb" });
    expect(s.orgs.acme?.git_accounts).toEqual([
      { host: "bitbucket.org", account: "acme-bb", token: "secret:s1" },
    ]);
    expect(s.orgs.acme?.mr_tokens).toEqual({ bitbucket: "secret:s1" });
    // Saved as email:token, so REST uses Basic with the email and git uses the static user name.
    expect(s.secrets.get("s1")).toBe(`${BB_EMAIL}:${BB_TOKEN}`);
    expect(s.orgs.globex?.git_accounts).toBeUndefined();
    for (const r of s.hosts.requests) expect(r.url).not.toContain(BB_TOKEN);
    expectNoSecrets(s);
  });

  it("a wrong email or token fails with a plain reason and saves nothing", async () => {
    const s = setup();
    bitbucket(s);
    const failed = await s.service.token(
      { org: "acme", kind: "bitbucket", token: BB_TOKEN, email: "someone@globex.test" },
      { actor: { kind: "owner" } },
    );
    s.outputs.push(failed);
    expect(failed).toMatchObject({ state: "failed" });
    if (failed.state === "failed")
      expect(failed.reason).toMatch(/^Bitbucket did not accept the email and token/);
    expect(s.secrets.size).toBe(0);
    expect(s.orgs.acme?.git_accounts).toBeUndefined();
    expectNoSecrets(s);
  });

  it("a pasted GitHub token whose account another workspace uses waits for a confirm", async () => {
    const s = setup({
      orgs: {
        private: { name: "Private" },
        acme: { name: "Acme" },
        globex: { name: "Globex", git_accounts: [{ host: "github.com", account: "octo-acme" }] },
      },
    });
    s.hosts.on("GET https://api.github.com/user", () => ({ json: { login: "octo-acme" } }));
    const asked = await s.service.token(
      { org: "acme", kind: "github", token: GH_TOKEN },
      { actor: { kind: "owner" } },
    );
    expect(asked).toMatchObject({ state: "confirm", alsoUsedBy: ["globex"] });
    expect(s.secrets.size).toBe(0);
    const done = await s.service.confirm(asked.signIn);
    expect(done.state).toBe("done");
    expect(s.orgs.acme?.mr_tokens).toEqual({ github: "secret:s1" });
    expect(s.orgs.globex?.mr_tokens).toBeUndefined();
  });
});

describe("git.signOut", () => {
  it("revokes a GitLab sign-in, drops its secrets and keeps the account and its SSH route", async () => {
    const orgs: Record<string, OrgConfig> = {
      private: { name: "Private" },
      acme: {
        name: "Acme",
        git_accounts: [
          {
            host: "gitlab.com",
            account: "acme-dev",
            ssh: "gitlab-acme",
            token: "secret:t",
            oauth: "secret:g",
          },
        ],
        mr_tokens: { gitlab: "secret:t", github: "secret:other" } as Partial<Record<MrHost, string>>,
      },
    };
    const s = setup({ orgs });
    s.secrets.set("t", GL_TOKEN);
    s.secrets.set("g", JSON.stringify({ clientId: "0123456789abcdef" }));
    s.hosts.on("POST https://gitlab.com/oauth/revoke", (req) => {
      expect(req.form).toEqual({ client_id: "0123456789abcdef", token: GL_TOKEN });
      return { json: {} };
    });
    const out = await s.service.signOut(
      { org: "acme", kind: "gitlab" },
      { command: "git.signOut", meta: { actor: { kind: "owner" } } },
    );
    s.outputs.push(out);
    expect(out).toEqual({
      org: "acme",
      kind: "gitlab",
      host: "gitlab.com",
      account: "acme-dev",
      removed: true,
      revoke: "revoked",
    });
    expect(orgs.acme?.git_accounts).toEqual([
      { host: "gitlab.com", account: "acme-dev", ssh: "gitlab-acme" },
    ]);
    expect(orgs.acme?.mr_tokens).toEqual({ github: "secret:other" });
    expect(s.dropped).toEqual(["secret:t", "secret:g"]);
    expectNoSecrets(s);
  });

  it("GitHub cannot be revoked without a client secret: majhi removes it and links the apps page", async () => {
    const orgs: Record<string, OrgConfig> = {
      private: { name: "Private" },
      acme: {
        name: "Acme",
        git_accounts: [{ host: "github.com", account: "octo-acme", token: "secret:t" }],
        mr_tokens: { github: "secret:t" },
      },
    };
    const s = setup({ orgs });
    s.secrets.set("t", GH_TOKEN);
    const out = await s.service.signOut(
      { org: "acme", kind: "github" },
      { command: "git.signOut", meta: { actor: { kind: "owner" } } },
    );
    expect(out).toMatchObject({
      removed: true,
      revoke: "local",
      revokeUrl: "https://github.com/settings/applications",
    });
    expect(orgs.acme?.mr_tokens).toBeUndefined();
    expect(s.hosts.requests).toEqual([]);
  });
});

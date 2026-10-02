import type { GitAccount, MrHost, OrgConfig, SignInStatus } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { type FakeGitHosts, fakeGitHosts } from "../testing/gitHosts.ts";
import type { EffectiveApps } from "./apps.ts";
import { SignInService } from "./signIn.ts";

const GH_TOKEN = "gho_SecretAcmeToken1234567890";
const GL_TOKEN = "glpat_SecretGitLabToken987654";
const GL_REFRESH = "glrt_SecretRefresh111";
const BB_TOKEN = "bbat_SecretBitbucketToken55";
const BB_CODE = "bb-code-secret-777";
const SECRETS = [GH_TOKEN, GL_TOKEN, GL_REFRESH, BB_TOKEN, BB_CODE, "dev-code-1", "consumer-secret-xyz"];

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
  } = {},
): Setup {
  const hosts = fakeGitHosts();
  const orgs: Record<string, OrgConfig> = options.orgs ?? {
    private: { name: "Private" },
    acme: { name: "Acme" },
    globex: { name: "Globex" },
  };
  const secrets = new Map<string, string>([["bitbucket-consumer", "consumer-secret-xyz"]]);
  const events: SignInStatus[] = [];
  const waits: number[] = [];
  const dropped: string[] = [];
  const opened: string[] = [];
  let n = 0;
  const service = new SignInService({
    fetch: hosts.fetch,
    ...(options.now === undefined ? {} : { now: options.now }),
    origin: () => "http://127.0.0.1:7070",
    apps: async () => ({
      ...(options.noGithub === true ? {} : { github: { clientId: "Ov23liAcmeExample01", builtIn: false } }),
      gitlab: { "gitlab.com": { clientId: "0123456789abcdef", builtIn: false } },
      bitbucket: { key: "AcmeConsumerKey01", secretRef: "secret:bitbucket-consumer" },
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
      expect(s.secrets.size).toBe(1);
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
    expect(s.secrets.size).toBe(1);
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

  it("answers needs-app with the setup steps when no GitHub app is set", async () => {
    const s = setup({ noGithub: true });
    const start = await s.service.start({ org: "acme", kind: "github" }, { actor: { kind: "owner" } });
    expect(start.state).toBe("needs-app");
    if (start.state !== "needs-app") return;
    expect(start.setup.needs).toEqual(["clientId"]);
    expect(start.setup.values).toContainEqual({ label: "Homepage URL", value: "http://127.0.0.1:7070" });
    expect(s.hosts.requests).toEqual([]);
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

  it("tells an old self-hosted GitLab plainly, and asks for an app on a host without one", async () => {
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
    expect(other.state).toBe("needs-app");
  });
});

describe("Bitbucket authorization code", () => {
  function bitbucket(s: Setup): void {
    s.hosts.on("POST https://bitbucket.org/site/oauth2/access_token", (req) => {
      const basic = `Basic ${Buffer.from("AcmeConsumerKey01:consumer-secret-xyz").toString("base64")}`;
      if (req.headers.authorization !== basic || req.form.code !== BB_CODE)
        return { status: 400, json: { error: "invalid_grant" } };
      return {
        json: {
          access_token: BB_TOKEN,
          refresh_token: "bb-refresh",
          expires_in: 7200,
          scopes: "account repository:admin",
        },
      };
    });
    s.hosts.on("GET https://api.bitbucket.org/2.0/user", (req) =>
      req.headers.authorization === `Bearer ${BB_TOKEN}`
        ? { json: { username: "acme-bb" } }
        : { status: 401, json: {} },
    );
  }

  it("ends the flow on the callback with a single-use state, and the page never echoes the code", async () => {
    const s = setup();
    bitbucket(s);
    const start = await s.service.start({ org: "acme", kind: "bitbucket" }, { actor: { kind: "owner" } });
    s.outputs.push(start);
    if (start.state !== "browser") throw new Error("not a browser flow");
    const state = new URL(start.authorizeUrl).searchParams.get("state") ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(start.authorizeUrl).searchParams.get("client_id")).toBe("AcmeConsumerKey01");

    const unknown = await s.service.bitbucketCallback({ state: "nope", code: BB_CODE });
    expect(unknown).toEqual({
      ok: false,
      message: "This sign-in link is not valid any more. Start again in majhi.",
    });

    const page = await s.service.bitbucketCallback({ state, code: BB_CODE });
    s.outputs.push(page);
    expect(page).toEqual({ ok: true, message: "Signed in to Bitbucket as acme-bb. Go back to majhi." });
    expect(s.service.poll(start.signIn)).toMatchObject({ state: "done", account: "acme-bb" });
    expect(s.orgs.acme?.mr_tokens).toEqual({ bitbucket: "secret:s1" });
    expect(s.orgs.acme?.git_accounts?.[0]).toMatchObject({ oauth: "secret:s2" });

    const again = await s.service.bitbucketCallback({ state, code: BB_CODE });
    expect(again.ok).toBe(false);
    expect(s.secrets.size).toBe(3);
    expectNoSecrets(s);
  });

  it("access_denied ends the flow as denied", async () => {
    const s = setup();
    bitbucket(s);
    const start = await s.service.start({ org: "acme", kind: "bitbucket" }, { actor: { kind: "owner" } });
    if (start.state !== "browser") throw new Error("not a browser flow");
    const state = new URL(start.authorizeUrl).searchParams.get("state") ?? "";
    expect((await s.service.bitbucketCallback({ state, error: "access_denied" })).ok).toBe(false);
    expect(s.service.poll(start.signIn).state).toBe("denied");
  });

  it("a code the consumer cannot exchange fails the flow without echoing it", async () => {
    const s = setup();
    bitbucket(s);
    const start = await s.service.start({ org: "acme", kind: "bitbucket" }, { actor: { kind: "owner" } });
    if (start.state !== "browser") throw new Error("not a browser flow");
    const state = new URL(start.authorizeUrl).searchParams.get("state") ?? "";
    const page = await s.service.bitbucketCallback({ state, code: "bb-code-secret-777-wrong" });
    s.outputs.push(page);
    expect(page.ok).toBe(false);
    expect(page.message).not.toContain("bb-code");
    expect(s.service.poll(start.signIn).state).toBe("failed");
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

  it("GitHub cannot be revoked without a client secret: majhi removes it and links the page", async () => {
    const orgs: Record<string, OrgConfig> = {
      private: { name: "Private" },
      acme: {
        name: "Acme",
        git_accounts: [{ host: "github.com", account: "octo-acme", token: "secret:t" }],
        mr_tokens: { github: "secret:t" },
      },
    };
    const s = setup({ orgs });
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

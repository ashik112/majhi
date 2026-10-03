import type { CommandMeta, GitAuth, MrHost, OrgConfig } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { errorMessage } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { git } from "../git/git.ts";
import type { HostLink } from "../host/link.ts";
import { hostNameOf } from "../mrs/remote.ts";
import { fetchPublicProfile } from "../orgs/gitAccount.ts";
import type { OrgService } from "../orgs/service.ts";
import type { ProjectService } from "../projects/service.ts";
import { readGitMeta } from "../scan/gitMeta.ts";
import { sshConfigHosts } from "../scan/sshConfig.ts";
import type { SecretService } from "../secrets/service.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/index.ts";
import { type EffectiveApps, effectiveApps, readGitApps } from "./apps.ts";
import { CloneService } from "./clone.ts";
import { CloneRepo } from "./cloneJobs.ts";
import type { Fetch } from "./http.ts";
import type { ProjectDeps } from "./project.ts";
import { SignInService } from "./signIn.ts";
import { credentialOf, GitTokens, tokenAuth } from "./tokens.ts";

/** A clone may take long on a slow link; the helper gives up after this. */
const CLONE_TIMEOUT_MS = 60 * 60_000;
const PUSH_TIMEOUT_MS = 130_000;
const LS_REMOTE_TIMEOUT_MS = 60_000;
const OPEN_URL_TIMEOUT_MS = 10_000;
/** A CLI sign-in lasts 15 minutes at most on the helper; the call waits a little longer. */
const CLI_LOGIN_TIMEOUT_MS = 16 * 60_000;

/** Git sign-in, tokens and clone jobs: the stateful parts of git connect, made once. */
export interface GitConnect {
  apps: () => Promise<EffectiveApps>;
  tokens: GitTokens;
  signIn: SignInService;
  clones: CloneService;
  /** Deps of create, publish and connect a remote. */
  projectDeps: ProjectDeps;
  /** SSH aliases from the owner's ~/.ssh/config, lowercased alias to host name. */
  aliases: () => Promise<ReadonlyMap<string, string>>;
  /** Registered projects with the URLs of their remotes. */
  projectRemotes: () => Promise<
    { id: string; org: string; path: string; aliases: string[]; remotes: string[] }[]
  >;
  fetch: Fetch;
}

/** The token auth of an https push for the project's org, when it has a token for the URL's host. */
export async function pushAuthFor(
  tokens: GitTokens,
  orgs: Record<string, OrgConfig>,
  org: string,
  url: string,
  kindOf: (host: string) => MrHost,
): Promise<GitAuth | undefined> {
  const host = hostNameOf(url)?.toLowerCase();
  if (host === undefined) return undefined;
  const kind = kindOf(host);
  const cred = credentialOf(orgs[org], kind, host);
  // Only a token the org saved for exactly this host: `mr_tokens` alone is a guess, and a wrong
  // token would hide the owner's own saved login.
  const exact = (orgs[org]?.git_accounts ?? []).some((a) => a.host === host && a.token !== undefined);
  if (!exact || cred.tokenRef === undefined) return undefined;
  const token = await tokens.value(cred.tokenRef).catch(() => undefined);
  return token === undefined ? undefined : tokenAuth(kind, token);
}

export interface GitConnectWiring {
  config: ConfigService;
  secrets: SecretStore;
  secretService: SecretService;
  orgs: OrgService;
  projects: ProjectService;
  store: Store;
  events: EventHub;
  hostLink: HostLink | undefined;
  hostHome: string;
  tokens: GitTokens;
  fetch: Fetch;
}

/** The tokens reader, made early so Ship and MRs read refreshed tokens. */
export function createGitTokens(config: ConfigService, secrets: SecretStore, fetchFn: Fetch): GitTokens {
  return new GitTokens({
    orgs: async () => (await config.sections()).orgs,
    secrets: { get: (name) => secrets.get(name), set: (name, value) => secrets.set(name, value) },
    fetch: fetchFn,
  });
}

export function createGitConnect(w: GitConnectWiring): GitConnect {
  const apps = async () => effectiveApps(await readGitApps(w.config.file));
  const orgsOf = async () => (await w.config.sections()).orgs;
  const connected = () => w.hostLink?.isConnected() ?? false;
  const link = w.hostLink;
  const signIn = new SignInService({
    fetch: w.fetch,
    apps,
    cli:
      link === undefined
        ? undefined
        : {
            connected: () => link.isConnected(),
            login: (params, onPage) =>
              link.call("git.cliLogin", params, CLI_LOGIN_TIMEOUT_MS, (p) => {
                if ("login" in p) onPage(p.login);
              }),
            cancel: async (signIn) => {
              if (link.isConnected()) await link.call("git.cliLoginCancel", { signIn }, OPEN_URL_TIMEOUT_MS);
            },
          },
    readSecret: (name) => w.secrets.get(name),
    openUrl: async (url) => {
      if (w.hostLink === undefined || !w.hostLink.isConnected()) return false;
      return (await w.hostLink.call("openUrl", { url }, OPEN_URL_TIMEOUT_MS)).opened;
    },
    orgs: orgsOf,
    saveSecret: (input) => w.secretService.save(input),
    dropSecret: async (ref) => {
      const name = ref.replace(/^secret:/, "");
      if ((await w.secretService.referencedBy(name)).length > 0) return;
      await w.secrets.delete(name);
    },
    publicProfile: (host, account) => fetchPublicProfile(host, account),
    writeOrg: async (id, patch, change) => {
      await w.orgs.update({ id, ...patch }, change.command, change.meta);
    },
    changed: (_flow, ended) => w.events.emit(ended ? ["signins", "orgs", "config", "secrets"] : ["signins"]),
  });
  const aliases = async (): Promise<ReadonlyMap<string, string>> => {
    const list = await sshConfigHosts(w.hostHome).catch(() => []);
    return new Map(
      list.flatMap((a) =>
        a.hostName === undefined ? [] : [[a.alias.toLowerCase(), a.hostName.toLowerCase()] as const],
      ),
    );
  };
  const projectRemotes = async () =>
    Promise.all(
      (await w.projects.infos()).map(async (p) => ({
        id: p.id,
        org: p.org,
        path: p.path,
        aliases: p.aliases,
        remotes: p.exists
          ? ((await readGitMeta(p.path).catch(() => undefined))?.remotes ?? []).map((r) => r.url)
          : [],
      })),
    );
  const roots = async () => {
    const loaded = await w.config.load();
    return {
      roots: loaded.state.status === "loaded" ? loaded.state.config.workspaces : [],
      hostHome: w.hostHome,
    };
  };
  const register = (
    input: Parameters<ProjectService["register"]>[0],
    change: { command: string; meta: CommandMeta },
  ) => w.projects.register(input, change.command, change.meta);
  const repo = new CloneRepo(w.store.raw);
  const clones = new CloneService({
    repo,
    roots,
    orgExists: async (org) => (await orgsOf())[org] !== undefined,
    projects: projectRemotes,
    aliases,
    tokens: w.tokens,
    hostConnected: connected,
    hostClone: async (params, onProgress) => {
      if (w.hostLink === undefined) throw new Error("no host link");
      return w.hostLink.call("git.clone", params, CLONE_TIMEOUT_MS, (p) => {
        if ("phase" in p) onProgress(p);
      });
    },
    register,
    changed: (registered) => w.events.emit(registered ? ["clones", "projects", "config"] : ["clones"]),
  });
  void (async () => {
    const paths = new Map((await w.projects.infos().catch(() => [])).map((p) => [p.path, p.id]));
    const n = await repo.recover((path) => paths.get(path));
    if (n > 0) w.events.emit(["clones"]);
  })().catch((err: unknown) => console.error(`Could not tidy interrupted clones: ${errorMessage(err)}`));

  const projectDeps: ProjectDeps = {
    roots,
    orgs: orgsOf,
    taken: async () => {
      const sections = await w.config.sections();
      return new Set(Object.entries(sections.projects).flatMap(([id, p]) => [id, ...p.aliases]));
    },
    project: (id) => w.projects.get(id),
    rawProject: async (id) => (await w.config.sections()).projects[id],
    register,
    update: (input, change) => w.projects.update(input, change.command, change.meta),
    aliases,
    tokens: w.tokens,
    fetch: w.fetch,
    hostConnected: connected,
    hostPush: async (params) => {
      if (w.hostLink === undefined) throw new Error("no host link");
      await w.hostLink.call("git.push", params, PUSH_TIMEOUT_MS);
    },
    hostLsRemote: async (params) => {
      if (w.hostLink === undefined) throw new Error("no host link");
      return w.hostLink.call("git.lsRemote", params, LS_REMOTE_TIMEOUT_MS);
    },
    serverPush: async (path, remote, branch) => {
      await git(
        path,
        ["push", "--quiet", "--set-upstream", remote, `refs/heads/${branch}:refs/heads/${branch}`],
        {
          timeoutMs: PUSH_TIMEOUT_MS,
        },
      );
      await git(path, ["branch", `--set-upstream-to=${remote}/${branch}`, branch]).catch(() => undefined);
    },
    serverFetch: async (path, remote) => {
      await git(path, ["fetch", "--quiet", remote], { timeoutMs: PUSH_TIMEOUT_MS });
    },
    audit: (row) => {
      const by = row.meta.actor.kind === "owner" ? "owner" : "agent";
      w.store.permissions.log({
        task: row.meta.task ?? "",
        org: row.org,
        agent: row.meta.actor.kind === "owner" ? "owner" : row.meta.actor.id,
        kind: "push",
        title: `Push of ${row.project}`,
        decision: row.ok ? "done" : "failed",
        by,
        at: new Date().toISOString(),
        detail: row.detail.slice(0, 400),
      });
    },
  };
  return {
    apps,
    tokens: w.tokens,
    signIn,
    clones,
    projectDeps,
    aliases,
    projectRemotes,
    fetch: w.fetch,
  };
}

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Budget,
  BudgetsPatch,
  BudgetsSettings,
  CommandMeta,
  CommandName,
  CommandOutput,
  commands,
  Remount,
  RoomItem,
  TaskId,
} from "@majhi/shared";
import { CHAT_BRIEF, PRIVATE, RESTART_COMMAND, sameImage, type Task } from "@majhi/shared";
import type { z } from "zod";
import { openBossChat, openChat } from "../admin/boss.ts";
import { cardStats } from "../admin/card-stats.ts";
import { sameRule } from "../admin/policy.ts";
import { agendaHandlers } from "../agenda/handlers.ts";
import { scheduleHandlers } from "../automation/handlers.ts";
import { autonomyHandlers } from "../autonomy/handlers.ts";
import { backupHandlers } from "../backup/handlers.ts";
import { captainHandlers } from "../captain/handlers.ts";
import { answerOnce } from "../captain/keys.ts";
import { chatHandlers } from "../chat/handlers.ts";
import { incidentHandlers } from "../chat/incident-handlers.ts";
import type { ConfigService } from "../config/service.ts";
import { connectHandlers } from "../connect/handlers.ts";
import { connectionHandlers } from "../connections/handlers.ts";
import { redactSecrets } from "../connections/redact.ts";
import { taskSecrets } from "../connections/run-files.ts";
import { connectionDir } from "../connections/service.ts";
import { conversationsHandlers } from "../conversations/handlers.ts";
import { environmentsProblem } from "../deploy/rails.ts";
import { editorPath } from "../editor/allowed.ts";
import { UserError } from "../errors.ts";
import { findingsHandlers } from "../findings/handlers.ts";
import { isDirectory } from "../fs.ts";
import { bitbucketKeyFingerprints, type KeyOwner } from "../git/keyOwners.ts";
import { gitConnectHandlers } from "../gitConnect/handlers.ts";
import { handoffHandlers } from "../handoff/handlers.ts";
import type { HealthService } from "../health/service.ts";
import { HostJobError, type HostLink, HostOfflineError } from "../host/link.ts";
import { inboxHandlers } from "../inbox/handlers.ts";
import { mcpHandlers } from "../mcp-servers/handlers.ts";
import { hostNameOf, repoSlug, rewriteRemoteUrl } from "../mrs/remote.ts";
import { TriggerAlias, triggerHandlers } from "../ops/anything/triggers.ts";
import { opsHandlers } from "../ops/handlers.ts";
import {
  checkSavedLogin,
  checkToken,
  fetchProbe,
  fetchPublicProfile,
  setGitAccount,
  tokenRequest,
  useSavedLogin,
} from "../orgs/gitAccount.ts";
import { type AdoptDeps, useGitLogin } from "../orgs/gitLogin.ts";
import { CheckCache, gitStatus } from "../orgs/gitStatus.ts";
import { outcomesHandlers } from "../outcomes/handlers.ts";
import { playbookHandlers } from "../playbooks/handlers.ts";
import { attributionOf, orgIdentity } from "../runs/attribution.ts";
import { commitBy } from "../runs/checkpoint.ts";
import { readGitMeta } from "../scan/gitMeta.ts";
import { classifyHost } from "../scan/remote.ts";
import type { RepoScanner } from "../scan/scanner.ts";
import { sshConfigHosts } from "../scan/sshConfig.ts";
import { restoreKey } from "../secrets/restore.ts";
import type { Services } from "../services.ts";
import { skillHandlers } from "../skills/handlers.ts";
import type { SshHostProbe } from "../ssh/hosts.ts";
import type { SystemService } from "../system/service.ts";
import { actorName } from "../tasks/cards.ts";
import { changeTaskBranch } from "../tasks/change-branch.ts";
import { reachFromChat } from "../tasks/chat-link.ts";
import { lookAtTask } from "../tasks/look.ts";
import type { Provenance } from "../tasks/provenance.ts";
import { readReport } from "../tasks/report.ts";
import { typist } from "../tasks/typing.ts";
import { toolsHandlers } from "../tools/handlers.ts";
import { gitDrift } from "../wiki/drift.ts";
import { wikiHandlers } from "../wiki/handlers.ts";
import { wikiEnabledFrom } from "../wiki/switch.ts";

/** Loading keys and asking the Keychain or keyring can take a few seconds. */
const SSH_CALL_TIMEOUT_MS = 40_000;

/** `gh auth token` is quick, but the helper may be busy. */
const GIT_TOKEN_TIMEOUT_MS = 20_000;
/** A read-only `git ls-remote` over SSH, to see whether a key reaches a repo. */
const REACH_TIMEOUT_MS = 20_000;

/** Writing the key file is quick: the helper answers before it restarts majhi. */
const KEY_RESTORE_TIMEOUT_MS = 30_000;

export interface CommandContext {
  command: CommandName;
  meta: CommandMeta;
}

/** Input after its schema parsed it, so defaults and trimming are applied. */
export type ParsedInput<N extends CommandName> = z.output<(typeof commands)[N]["input"]>;

export type CommandHandler<N extends CommandName> = (
  input: ParsedInput<N>,
  ctx: CommandContext,
) => Promise<CommandOutput<N>>;

/** One handler per command. Adding a command to the shared registry without a handler fails the type check. */
export type CommandHandlers = { [N in CommandName]: CommandHandler<N> };

export interface HandlerDeps {
  config: ConfigService;
  scanner: RepoScanner;
  hostLink: HostLink;
  services: Services;
  /** Probes the git hosts registered projects use. Tests may leave it out. */
  sshHosts?: SshHostProbe;
  /** `health.run` and `health.fix`. Without it they answer 501. */
  health?: HealthService;
  /** `system.version` and `system.update`. Without it they answer 501. */
  system?: SystemService;
}

/**
 * Who made a task through `tasks.create`. A child's origin is its parent link. Otherwise the owner, or an
 * agent, which is recorded as the captain with the reason it gave (the origin kinds name no other agent).
 */
/** The ordinary chat with an agent a call comes from, or undefined: only an agent's call from one counts. */
function chatOf(store: Services["store"], ctx: CommandContext): Task | undefined {
  if (ctx.meta.actor.kind !== "agent" || ctx.meta.task === undefined) return undefined;
  const from = store.tasks.get(ctx.meta.task);
  return from !== undefined && from.kind === "chat" && from.brief === CHAT_BRIEF ? from : undefined;
}

/**
 * An agent's call on a task other than the one it works in: allowed for a task its chat made or the
 * owner named there (`reachFromChat`), and for the lead of its own task. The owner may always.
 */
function mayReach(store: Services["store"], ctx: CommandContext, id: string): void {
  const { actor, task } = ctx.meta;
  if (actor.kind === "owner") return;
  const reach =
    task === undefined
      ? ({ ok: false, why: "This call has no task of its own." } as const)
      : reachFromChat(store, { task, agent: actor.id }, id);
  if (!reach.ok) throw new UserError(reach.why, 409);
}

function createdBy(ctx: CommandContext, child: boolean): Provenance {
  if (child) return { kind: "child" };
  const actor = ctx.meta.actor;
  if (actor.kind === "owner") return { kind: "owner" };
  return { kind: "captain", reason: ctx.meta.reason?.trim() || `Created by @${actor.id}` };
}

/** How long a `tasks.create` request id is remembered. */
const CREATE_DEDUPE_MS = 5 * 60_000;

export function createHandlers({
  config,
  scanner,
  hostLink,
  services,
  sshHosts,
  health,
  system,
}: HandlerDeps): CommandHandlers {
  const { orgs, accounts, agents } = services;
  const chatDeps = () => ({
    config,
    store: services.store,
    tasks: services.tasks,
    agents: services.agentStore,
  });
  const adoptDeps = (ctx: CommandContext): AdoptDeps => ({
    readToken: async (via, host) =>
      (await hostLink.call("git.token", { via, host }, GIT_TOKEN_TIMEOUT_MS)).token,
    saveSecret: (secret) => services.secretService.save(secret),
    orgTokens: async (id) => {
      const org = (await config.sections()).orgs[id];
      return org === undefined ? undefined : (org.mr_tokens ?? {});
    },
    setOrgTokens: async (id, tokens) => {
      await orgs.update({ id, mr_tokens: tokens }, ctx.command, ctx.meta);
    },
  });
  /** An org agent reaches only its own org; a root agent (the captain) and the owner any. */
  const agentReaches = async (meta: CommandMeta, org: string): Promise<void> => {
    if (meta.actor.kind !== "agent") return;
    const stored = await services.agentStore.get(meta.actor.id);
    const scope = stored?.ok === true ? stored.agent.frontmatter.scope : undefined;
    if (scope !== "root" && scope !== org) {
      throw new UserError("That is in another org: you can only change your own org's deploys.", 409);
    }
  };
  const gitChecks = new CheckCache();
  /** `tasks.create` calls by their request id, kept a few minutes: the same id returns the first task. */
  const recentCreates = new Map<string, { at: number; made: ReturnType<typeof services.tasks.create> }>();
  const readSaved = async (host: string, account: string) =>
    (await hostLink.call("git.credential", { host, username: account }, GIT_TOKEN_TIMEOUT_MS)).secret;
  /**
   * One SSH remote of the org's projects on the host, to prove a key reaches the workspace: the one in the
   * account's own workspace when there is one. `url` is reached through the key's alias, when it has one.
   */
  const sshTargetOf = async (org: string, host: string, account: string) => {
    const aliases = await sshConfigHosts(config.paths.hostHome).catch(() => []);
    const projects = (await services.projects.infos()).filter((p) => p.org === org && p.exists);
    const found: Array<{ url: string; slug: string }> = [];
    for (const p of projects) {
      const meta = await readGitMeta(p.path).catch(() => undefined);
      for (const remote of meta?.remotes ?? []) {
        const name = hostNameOf(remote.url)?.toLowerCase();
        if (name === undefined || /^https?:\/\//i.test(remote.url)) continue;
        const real = aliases.find((x) => x.alias.toLowerCase() === name)?.hostName?.toLowerCase() ?? name;
        if (real === host) found.push({ url: remote.url, slug: repoSlug(remote.url) });
      }
    }
    return found.find((f) => f.slug.split("/")[0]?.toLowerCase() === account.toLowerCase()) ?? found[0];
  };
  /**
   * The Bitbucket accounts of the orgs, each with the fingerprints of the SSH keys registered on it (when
   * its token can list them) and a read-only reach check, so an accepted key that names no account can be
   * tied to one. Cached with the other status checks.
   */
  const keyOwnersOf = async (host: string): Promise<KeyOwner[]> => {
    if (classifyHost(host) !== "bitbucket") return [];
    const orgs = (await config.sections()).orgs;
    const accounts = Object.entries(orgs).flatMap(([org, o]) =>
      (o.git_accounts ?? [])
        .filter((a) => a.host === host)
        .map((a) => ({ org, account: a.account, ref: a.token ?? o.mr_tokens?.bitbucket })),
    );
    return Promise.all(
      accounts.map(async ({ org, account, ref }): Promise<KeyOwner> => {
        const fingerprints =
          ref === undefined
            ? undefined
            : await gitChecks.get(`keys\n${host}\n${account.toLowerCase()}\n${ref}`, async () => {
                const value = await services.gitConnect.tokens.value(ref).catch(() => undefined);
                if (value === undefined) return undefined;
                const request = tokenRequest(host, "bitbucket", account, value, { stored: true });
                const me = await fetchProbe(request.url, request.headers).catch(() => undefined);
                const uuid = (me?.body as { uuid?: unknown } | undefined)?.uuid;
                return typeof uuid === "string"
                  ? bitbucketKeyFingerprints(fetchProbe, request.headers, uuid)
                  : undefined;
              });
        if (fingerprints !== undefined) return { account, fingerprints };
        const target = await sshTargetOf(org, host, account);
        if (target === undefined) return { account, fingerprints };
        return {
          account,
          fingerprints,
          target: target.slug,
          reach: (alias) =>
            gitChecks.get(`reach\n${host}\n${org}\n${account.toLowerCase()}\n${alias ?? ""}`, () =>
              hostLink
                .call(
                  "git.lsRemote",
                  { url: rewriteRemoteUrl(target.url, alias ?? host), auth: { kind: "ssh" } },
                  REACH_TIMEOUT_MS,
                )
                .then(() => true)
                .catch(() => false),
            ),
        };
      }),
    );
  };
  services.gitLogins.setKeyOwners(keyOwnersOf);
  /** Host names of the remotes of an org's projects, with ~/.ssh/config aliases resolved. */
  const usedHosts = async (id: string): Promise<string[]> => {
    const aliases = await sshConfigHosts(config.paths.hostHome).catch(() => []);
    const projects = (await services.projects.infos()).filter((p) => p.org === id && p.exists);
    const hosts = new Set<string>();
    for (const p of projects) {
      const meta = await readGitMeta(p.path).catch(() => undefined);
      for (const remote of meta?.remotes ?? []) {
        const name = hostNameOf(remote.url)?.toLowerCase();
        if (name === undefined) continue;
        const real = aliases.find((a) => a.alias.toLowerCase() === name)?.hostName?.toLowerCase() ?? name;
        if (real.includes(".")) hosts.add(real);
      }
    }
    return [...hosts];
  };
  const viewOf = async (id: string) => {
    const org = (await orgs.list()).find((o) => o.id === id);
    if (org === undefined) throw new UserError(`Org "${id}" does not exist.`, 404);
    return org;
  };
  return {
    ...scheduleHandlers(services.automation.schedules),
    ...triggerHandlers(new TriggerAlias(services.ops.engine)),
    ...autonomyHandlers(services.autonomy),
    ...captainHandlers(services.captain, services.autonomy),
    ...inboxHandlers(services.inbox),
    ...conversationsHandlers(services.conversations),
    ...chatHandlers(services.chat),
    ...incidentHandlers({
      incidents: services.chatParts.incidents,
      lane: async (task) => {
        const org = services.lanes.orgOf(task);
        const boss = await services.lanes.boss();
        return org === undefined || boss === undefined ? undefined : { boss, org };
      },
      orgOf: (task) => services.store.tasks.get(task)?.org,
    }),
    ...agendaHandlers({
      agenda: services.agenda,
      findings: services.findings,
      lanes: services.lanes,
      store: services.store,
    }),
    ...findingsHandlers({ findings: services.findings, lanes: services.lanes, store: services.store }),
    ...wikiHandlers({
      repo: services.store.wiki,
      enabled: wikiEnabledFrom(config),
      drift: gitDrift(services.projects),
      service: services.wiki,
      asker: services.wikiAsk,
      lanes: services.lanes,
      store: services.store,
      orgs: async () => Object.keys((await config.sections()).orgs),
      projects: async (org) =>
        Object.entries((await config.sections()).projects)
          .filter(([, p]) => (p.org ?? PRIVATE) === org)
          .map(([id]) => id),
    }),
    ...playbookHandlers({
      findings: services.findings,
      lanes: services.lanes,
      store: services.store,
      playbooks: services.playbooks,
      goals: services.goals,
      outbound: services.outbound,
    }),
    ...opsHandlers({
      watch: services.ops.watch,
      engine: services.ops.engine,
      phone: services.ops.phone,
      playbooks: services.playbooks,
      repo: services.ops.repo,
      findings: services.findings,
      lanes: services.lanes,
      store: services.store,
    }),
    ...outcomesHandlers({
      findings: services.findings,
      lanes: services.lanes,
      store: services.store,
      outcomes: services.outcomes,
    }),
    ...handoffHandlers({
      findings: services.findings,
      lanes: services.lanes,
      store: services.store,
      handoff: services.handoff,
    }),
    ...backupHandlers(services.backup),
    ...connectHandlers(services.connect),
    ...connectionHandlers(services.connections, services.connectionTests, services.secretService, {
      connect: services.connect,
      gitConnect: services.gitConnect,
      gitLink: services.gitLink,
      mcpUrl: services.mcpUrl,
    }),
    ...skillHandlers(services.skills),
    ...toolsHandlers({
      tools: services.tools,
      findings: services.findings,
      lanes: services.lanes,
      store: services.store,
    }),
    ...mcpHandlers(services.mcpServers),
    ...gitConnectHandlers({ config, scanner, hostLink, services }),

    "config.get": async () => (await config.load()).state,

    "repos.scan": async (input) => {
      const loaded = await config.load();
      if (loaded.state.status !== "loaded") {
        return { roots: [], scannedAt: new Date().toISOString(), durationMs: 0 };
      }
      const scan = await scanner.scan(
        { config: loaded.state.config, projectPaths: loaded.projectPaths, hostHome: config.paths.hostHome },
        input.refresh === true,
      );
      // A repo in a workspace's folder that is not a project yet wakes that workspace's projects chore (5.18).
      const folders = new Set(
        scan.roots.flatMap((r) =>
          r.repos.filter((repo) => !repo.registered).map((repo) => repo.relPath.split("/")[0] ?? ""),
        ),
      );
      const sections = await config.sections();
      const orgs = ["private", ...Object.keys(sections.orgs)].filter(
        (id) => folders.has(id) || folders.has((sections.orgs[id]?.name ?? "").toLowerCase()),
      );
      if (orgs.length > 0) services.captain.reposSeen(orgs);
      return scan;
    },

    "workspaces.set": async (input, ctx) => {
      const tasks = input.tasks_dir === undefined ? "" : `, tasks_dir ${input.tasks_dir}`;
      const loaded = await config.setWorkspaces(input, {
        command: ctx.command,
        meta: ctx.meta,
        summary: `set workspaces to ${input.workspaces.join(", ")}${tasks}`,
      });
      const unmounted = await findUnmounted(
        loaded.state.status === "loaded" ? loaded.state.config.workspaces : [],
      );
      return {
        state: loaded.state,
        unmounted,
        remount: await requestRemount(hostLink, unmounted),
        restartCommand: RESTART_COMMAND,
      };
    },

    "workspaces.remount": async () => {
      const { state } = await config.load();
      const unmounted = await findUnmounted(state.status === "loaded" ? state.config.workspaces : []);
      return { remount: await requestRemount(hostLink, unmounted), unmounted };
    },

    "host.status": async () => {
      const hosts = sshHosts?.cached();
      return hosts === undefined || hosts.length === 0
        ? hostLink.status()
        : { ...hostLink.status(), sshHosts: hosts };
    },

    "ssh.hosts": () => sshConfigHosts(config.paths.hostHome),
    "ssh.keys": async () => {
      const names = await readdir(join(config.paths.hostHome, ".ssh")).catch(() => [] as string[]);
      return names
        .filter((n) => /^[A-Za-z0-9._-]{1,128}\.pub$/.test(n))
        .map((n) => `~/.ssh/${n}`)
        .sort();
    },
    "git.logins": (input) => services.gitLogins.list(input.refresh === true),

    "orgs.useGitLogin": (input, ctx) => useGitLogin(adoptDeps(ctx), input),

    "orgs.setGitAccount": async (input, ctx) => {
      // A raw token from an agent has passed through its chat. Agents ask the owner with a secret request.
      if (input.token !== undefined && ctx.meta.actor.kind === "agent") {
        throw new UserError("Agents cannot pass a token. Ask the owner for it with a secret request.", 409);
      }
      await setGitAccount(
        {
          org: async (id) => {
            const org = (await config.sections()).orgs[id];
            return org === undefined
              ? undefined
              : { identity: org.identity, accounts: org.git_accounts ?? [], mrTokens: org.mr_tokens };
          },
          logins: () => services.gitLogins.list().then((r) => r.hosts),
          adopt: async (via, host) => (await useGitLogin(adoptDeps(ctx), { id: input.id, via, host })).ref,
          saveSecret: (secret) => services.secretService.save(secret),
          publicProfile: fetchPublicProfile,
          probe: fetchProbe,
          classify: classifyHost,
          write: async (id, patch) => {
            await orgs.update({ id, ...patch }, ctx.command, ctx.meta);
          },
        },
        input,
      );
      return viewOf(input.id);
    },

    "orgs.useSavedLogin": async (input, ctx) => {
      if (ctx.meta.actor.kind === "agent") {
        throw new UserError(
          "Only the owner can use this computer's saved login, under Git accounts on the Workspaces page.",
          409,
        );
      }
      return useSavedLogin(
        {
          org: async (id) => {
            const org = (await config.sections()).orgs[id];
            return org === undefined
              ? undefined
              : { identity: org.identity, accounts: org.git_accounts ?? [] };
          },
          readSecret: readSaved,
          probe: fetchProbe,
          saveSecret: (secret) => services.secretService.save(secret),
          write: async (id, patch) => {
            const current = (await config.sections()).orgs[id]?.mr_tokens ?? {};
            await orgs.update(
              {
                id,
                git_accounts: patch.git_accounts,
                mr_tokens: { ...current, [patch.mr_token.host]: patch.mr_token.ref },
              },
              ctx.command,
              ctx.meta,
            );
          },
        },
        classifyHost,
        input,
      );
    },

    "orgs.gitStatus": async (input) => {
      if (input.refresh === true) gitChecks.clear();
      return gitStatus(
        {
          org: async (id) => {
            const org = (await config.sections()).orgs[id];
            return org === undefined
              ? undefined
              : {
                  accounts: org.git_accounts ?? [],
                  mrTokens: org.mr_tokens ?? {},
                  dismissed: org.dismissed_logins ?? [],
                };
          },
          usedHosts,
          logins: async () => {
            if (!hostLink.isConnected()) return undefined;
            const { hosts } = await services.gitLogins.list(input.refresh === true);
            return { hosts, checkedAt: services.gitLogins.checkedAt() ?? new Date().toISOString() };
          },
          checkToken: (host, kind, account, ref) =>
            gitChecks.get(`token\n${host}\n${ref}`, async () => {
              // Refreshed first when it came from signing in and is about to expire.
              const value = await services.gitConnect.tokens.value(ref).catch(() => undefined);
              if (value === undefined) return { state: "refused" as const };
              return checkToken(fetchProbe, tokenRequest(host, kind, account, value, { stored: true }));
            }),
          savedLogin: (host, kind, account) =>
            gitChecks.get(`saved\n${host}\n${account.toLowerCase()}`, () =>
              checkSavedLogin({ readSecret: readSaved, probe: fetchProbe }, host, kind, account),
            ),
          classify: classifyHost,
          keyOwners: keyOwnersOf,
        },
        input.id,
      );
    },

    "orgs.dismissGitLogin": async (input, ctx) => {
      const org = (await config.sections()).orgs[input.id];
      if (org === undefined) throw new UserError(`Org "${input.id}" does not exist.`, 404);
      const host = input.host.toLowerCase();
      const current = org.dismissed_logins ?? [];
      if (current.some((d) => d.host === host && d.account.toLowerCase() === input.account.toLowerCase())) {
        return viewOf(input.id);
      }
      return orgs.update(
        { id: input.id, dismissed_logins: [...current, { host, account: input.account }] },
        ctx.command,
        ctx.meta,
      );
    },

    "orgs.removeGitAccount": async (input, ctx) => {
      const org = (await config.sections()).orgs[input.id];
      if (org === undefined) throw new UserError(`Org "${input.id}" does not exist.`, 404);
      const host = input.host.toLowerCase();
      const rest = (org.git_accounts ?? []).filter(
        (a) => !(a.host === host && a.account.toLowerCase() === input.account.toLowerCase()),
      );
      return orgs.update(
        { id: input.id, git_accounts: rest.length === 0 ? null : rest },
        ctx.command,
        ctx.meta,
      );
    },

    "ssh.reload": async () => {
      const ssh = await hostLink.call("ssh.reload", {}, SSH_CALL_TIMEOUT_MS);
      hostLink.noteSsh(ssh);
      // New keys may change what the git hosts answer.
      await sshHosts?.refresh().catch(() => undefined);
      return ssh;
    },

    "ssh.unlock": async (input) => {
      // Only a key the helper reported as waiting for a passphrase. The helper checks again.
      if (hostLink.status().info?.ssh?.needsPassphrase.includes(input.key) !== true) {
        throw new UserError(`${input.key} is not waiting for a passphrase.`);
      }
      // The passphrase goes to the helper in this one job and nowhere else: it is not logged,
      // kept, or put in an error. Errors below carry the helper's fixed sentence only.
      const ssh = await hostLink.call(
        "ssh.unlock",
        { key: input.key, passphrase: input.passphrase },
        SSH_CALL_TIMEOUT_MS,
      );
      hostLink.noteSsh(ssh);
      await sshHosts?.refresh().catch(() => undefined);
      return ssh;
    },

    "editor.open": async (input) => {
      const loaded = await config.load();
      if (loaded.state.status !== "loaded") throw new UserError("Pick workspace roots first.", 409);
      const { workspaces, tasksDir } = loaded.state.config;
      const path = await editorPath(input.path, [...workspaces, tasksDir, ...loaded.projectPaths]);
      const { editor } = await config.settings();
      await hostLink.call("editor.open", {
        app: editor.app,
        path,
        ...(input.line === undefined ? {} : { line: input.line }),
      });
      return { app: editor.app, path };
    },

    "notify.test": () => services.notifier.test(),
    "notify.pending": async () => services.tasks.pendingForOwner(),

    "fs.listDirs": (input) =>
      hostLink.call("listDirs", {
        path: input.path ?? config.paths.hostHome,
        showHidden: input.showHidden ?? false,
      }),

    "fs.suggestRoots": () => hostLink.call("suggestRoots", {}),

    "tools.list": async () => services.runtime.toolInfos(),

    "orgs.list": () => orgs.list(),
    "orgs.create": (input, ctx) => orgs.create(input, ctx.command, ctx.meta),
    "orgs.update": (input, ctx) => orgs.update(input, ctx.command, ctx.meta),

    "orgs.rename": (input, ctx) => orgs.rename(input.id, input.newId, ctx.command, ctx.meta),

    "accounts.list": () => accounts.list(),
    "accounts.suggestId": async (input) => ({ id: await accounts.suggestId(input.tool, input.org) }),
    "accounts.create": (input, ctx) => accounts.create(input, ctx.command, ctx.meta),
    "accounts.remove": async (input, ctx) => {
      await accounts.remove(input.id, ctx.command, ctx.meta);
      return { removed: input.id };
    },
    "accounts.login.start": (input) => services.startLogin(input.id),
    "accounts.health": (input) => accounts.health(input.id),
    "accounts.usage": (input) => accounts.usage(input.id, input.refresh === true),
    "accounts.hideModel": (input, ctx) =>
      accounts.hideModel(input.id, input.model, input.hidden, ctx.command, ctx.meta),
    "accounts.models": (input) => accounts.models(input.id, input.refresh === true),

    "agents.list": () => agents.list(),
    "agents.create": (input, ctx) => agents.create(input.id, input, ctx.command, ctx.meta),
    "agents.update": (input, ctx) => agents.update(input.id, input, ctx.command, ctx.meta),
    "agents.edit": (input, ctx) =>
      agents.edit(input.id, { set: input.set, instructions: input.instructions }, ctx.command, ctx.meta),
    "agents.attached": async (input) => {
      const last = services.store.runs.lastTools(input.id);
      return last === undefined ? null : { agent: input.id, ...last };
    },
    "agents.duplicate": (input, ctx) => agents.duplicate(input.id, input.newId, ctx.command, ctx.meta),
    "agents.remove": async (input, ctx) => {
      await agents.remove(input.id, ctx.command, ctx.meta);
      return { removed: input.id };
    },
    "agents.rename": (input, ctx) => agents.rename(input.id, input.newId, ctx.command, ctx.meta),
    "agents.health": (input) => agents.health(input.id),
    "boss.set": async (input, ctx) => {
      await agents.setBoss(input.id, ctx.command, ctx.meta);
      return { boss: input.id };
    },

    "projects.list": () => services.projects.list(),
    "projects.register": async (input, ctx) => {
      const view = await services.projects.register(input, ctx.command, ctx.meta);
      services.cards.onRegistered(input.id);
      return view;
    },
    "projects.cards": async (input) => services.cards.list(input.project),
    "projects.cardRefresh": (input) => services.cards.refresh(input.project),
    "projects.update": async (input, ctx) => {
      // Protection is the owner's guard on their infra: an agent may turn it on, never off.
      if (input.protected === false && ctx.meta.actor.kind === "agent") {
        const current = (await services.projects.infos()).find((p) => p.id === input.id);
        if (current?.protected === true) {
          throw new UserError(
            `Only the owner can turn protection off for ${input.id}, on the Projects and links page.`,
            409,
          );
        }
      }
      return services.projects.update(input, ctx.command, ctx.meta);
    },
    "projects.fetch": async (input, ctx) => {
      // An org agent fetches only its own org's projects; a root agent (the captain) and the owner any.
      if (ctx.meta.actor.kind === "agent") {
        const stored = await services.agentStore.get(ctx.meta.actor.id);
        const scope = stored?.ok === true ? stored.agent.frontmatter.scope : undefined;
        const project = (await services.projects.infos()).find((p) => p.id === input.project);
        if (scope !== "root" && project !== undefined && project.org !== scope) {
          throw new UserError(
            `${input.project} is in another org: you can only fetch your own org's projects.`,
            409,
          );
        }
      }
      return services.mrs.fetchProject(input);
    },
    "projects.deployView": (input) => services.deploy.view(input.project),
    "projects.setEnvironments": async (input, ctx) => {
      const info = await services.projects.get(input.project);
      await agentReaches(ctx.meta, info.org);
      const problem = environmentsProblem(
        info.deploy,
        input.environments,
        ctx.meta.actor.kind === "agent" ? "captain" : "owner",
      );
      if (problem !== undefined) throw new UserError(problem, 409);
      await services.projects.setEnvironments(input.project, input.environments, ctx.command, ctx.meta);
      return services.deploy.view(input.project);
    },
    "projects.planDeploy": async (input, ctx) => {
      await agentReaches(ctx.meta, services.tasks.get(input.task)?.org ?? PRIVATE);
      return services.deploy.service.plan(input, ctx.meta.actor.kind === "agent" ? "captain" : "owner");
    },
    // A deploy leaves the machine: the owner's click, or the captain by a rule the owner wrote (never through here).
    "projects.deploy": async (input, ctx) => {
      if (ctx.meta.actor.kind !== "owner") throw new UserError("Only the owner deploys from here.", 409);
      return services.deploy.service.deploy(input, "owner");
    },
    "projects.rollback": async (input, ctx) => {
      if (ctx.meta.actor.kind !== "owner") throw new UserError("Only the owner rolls a deploy back.", 409);
      return services.deploy.service.rollback(input.record, "owner");
    },
    "projects.holdDeploy": async (input, ctx) => {
      if (ctx.meta.actor.kind !== "owner") throw new UserError("Only the owner holds a deploy.", 409);
      return services.deploy.service.hold(input);
    },
    "projects.remove": async (input, ctx) => {
      await services.projects.remove(input.id, ctx.command, ctx.meta);
      services.cards.forget(input.id);
      return { removed: input.id };
    },

    // The captain's workspace threads are not tasks to the owner: they never show in a list.
    "tasks.list": async (input) =>
      services.tasks.list(input.includeDone === true).filter((t) => t.lane !== true),
    "tasks.changed": async (input) => {
      const tasks = services.tasks.list(true, input.ids).filter((t) => t.lane !== true);
      if (input.decisions !== true) return { tasks, counts: await services.inbox.workCounts() };
      const named = new Set(input.ids);
      const { decisions, counts } = await services.inbox.view();
      return { tasks, counts, decisions: decisions.filter((d) => d.task !== undefined && named.has(d.task)) };
    },
    "tasks.blockers": async () => services.autonomy.blockers(),
    "tasks.homeFacts": async () => {
      const { checks, background } = await services.homeChecks.facts();
      for (const p of services.processes.listAll()) {
        if (p.status !== "running") continue;
        background.push({
          task: p.task,
          kind: p.container === undefined ? "process" : p.container.kind,
          label: (p.container?.name ?? p.name).slice(0, 80),
          since: p.startedAt,
        });
      }
      return {
        mrs: services.store.tasks.openMrs(),
        doing: services.room.workingNow().map(({ task, live }) => ({
          task,
          agent: live.agent,
          ...(live.nowDoing === undefined ? {} : { text: live.nowDoing }),
          ...(live.turnAt === undefined ? {} : { since: live.turnAt }),
        })),
        checks,
        background,
        deploys: await services.deploy.board(),
      };
    },
    "tasks.get": async (input) => services.tasks.get(input.id),
    "tasks.detail": async (input) => services.taskDetails.detail(input.id),
    "tasks.areas": async (input) => services.taskDetails.areas(input.ids),
    "tasks.areaNames": async (input) => ({ names: await services.taskDetails.areaNames(input.org) }),
    "tasks.setType": async (input, ctx) => {
      const task = services.tasks.get(input.id);
      const who = typist(ctx.meta.actor, {
        boss: await services.lanes.boss(),
        lane: ctx.meta.task === undefined ? undefined : services.lanes.orgOf(ctx.meta.task),
        taskOrg: task.org ?? PRIVATE,
      });
      if ("refusal" in who) throw new UserError(who.refusal, 409);
      return services.tasks.setType(input.id, input.type, who.by);
    },
    "captain.reportBug": async (input, ctx) => {
      // majhi's own code: the Private project named majhi, or the one whose folder is called majhi.
      const own = (await services.projects.list()).find(
        (p) => p.org === PRIVATE && (p.id === "majhi" || /[\\/]majhi$/.test(p.path)),
      );
      if (own === undefined) {
        throw new UserError(
          "No project in the Private workspace is majhi's own code. Tell the owner the bug instead.",
          404,
        );
      }
      const text = `majhi bug: ${input.title}\n\n${input.details}`;
      const captured = await services.secretService.capture(text);
      const task = await services.tasks.create({
        text: captured.text,
        org: PRIVATE,
        repos: [{ project: own.id }],
        attachments: [],
        start: false,
        from: ctx.meta.task,
        byOwner: false,
        provenance: { kind: "captain", reason: "A bug in majhi's own code, reported by an agent" },
        typing: { type: "bug", by: "captain" },
      });
      noteSecrets(services, task.id, captured.saved);
      return { task: task.id };
    },
    "tasks.create": ({ requestId, ...input }, ctx) => {
      const now = Date.now();
      for (const [key, seen] of recentCreates)
        if (now - seen.at > CREATE_DEDUPE_MS) recentCreates.delete(key);
      const key = requestId === undefined ? undefined : `${ctx.meta.actor.kind}:${requestId}`;
      const earlier = key === undefined ? undefined : recentCreates.get(key);
      if (earlier !== undefined) return earlier.made;
      const made = (async () => {
        // A secret in the task text must not reach TASK.md or the agent.
        const captured = await services.secretService.capture(input.text);
        const byOwner = ctx.meta.actor.kind === "owner";
        const { type, separate, ...rest } = input;
        // An agent in an ordinary chat: the chat becomes the task, unless it asked for a separate one.
        const chat = chatOf(services.store, ctx);
        const joined =
          input.parent !== undefined || input.followUpOf !== undefined || input.dependsOn.length > 0;
        const promote = chat !== undefined && separate !== true && !joined;
        const task = await services.tasks.create({
          ...rest,
          text: captured.text,
          from: ctx.meta.task,
          byOwner,
          provenance:
            chat === undefined || joined
              ? createdBy(ctx, input.parent !== undefined)
              : { kind: "in-chat", room: chat.id },
          ...(promote ? { promote: chat.id } : {}),
          ...(type === undefined ? {} : { typing: { type, by: byOwner ? "owner" : "captain" } }),
        });
        noteSecrets(services, task.id, captured.saved);
        return task;
      })();
      if (key !== undefined) {
        recentCreates.set(key, { at: now, made });
        // A failed create can be tried again with the same id.
        made.catch(() => recentCreates.delete(key));
      }
      return made;
    },
    "tasks.report": async (input) => {
      const task = services.tasks.get(input.id);
      const report = await readReport(task.folder);
      if (report === undefined) return null;
      // The report is shown with the task's connection secrets kept out (5.14).
      const majhiHome = config.paths.majhiHome;
      const secrets = await taskSecrets(
        {
          config,
          secrets: services.secrets,
          majhiHome,
          connectionDir: (id) => connectionDir(majhiHome, id),
          oauth: (id) => services.connect.bearer(id),
        },
        task,
      );
      return { ...report, content: redactSecrets(report.content, secrets) };
    },
    "tasks.start": async (input, ctx) => {
      const by = ctx.meta.actor.kind === "agent" ? `@${ctx.meta.actor.id}` : "owner";
      if (input.message === undefined) return services.tasks.start(input.id, by);
      // The message starts the task and reaches its agent, in order: wait until it was delivered.
      await services.tasks.send({
        task: input.id,
        text: input.message,
        attachments: [],
        mode: "queue",
      });
      await services.runs.idleDeliveries(input.id);
      return services.tasks.get(input.id);
    },
    "tasks.slots": async () =>
      services.runs.capacity(Object.keys((await services.config.sections()).accounts)),
    "tasks.stop": async (input, ctx) => {
      const stopped = await services.tasks.stop(input.id, "owner", undefined, actorName(ctx.meta.actor));
      // The owner's own stop: autonomous mode does not restart this task on Resume.
      if (ctx.meta.actor.kind === "owner") services.autonomy.forgetHold(input.id);
      return stopped;
    },
    "tasks.update": (input) => services.tasks.update(input),
    "tasks.close": (input, ctx) =>
      services.tasks.close(input.id, {
        by: actorName(ctx.meta.actor),
        agent: ctx.meta.actor.kind === "agent",
        whenUnshipped: input.unshipped ?? "refuse",
      }),
    "tasks.reopen": (input) => services.tasks.reopen(input.id),
    "tasks.merge": ({ push, pushLocalCommits, createRemoteBranch, ...input }, ctx) => {
      if (input.confirmProtected !== undefined && ctx.meta.actor.kind === "agent") {
        throw new UserError("Only the owner can ship a protected repo, from Ship in the task.", 409);
      }
      // The captain and agents can never merge past the checks: only the owner's own call may.
      if (input.confirmChecks !== undefined && ctx.meta.actor.kind !== "owner") {
        throw new UserError("Only the owner can merge past a failed check.", 409);
      }
      if ((pushLocalCommits || createRemoteBranch) && ctx.meta.actor.kind === "agent") {
        throw new UserError(
          "Only the owner can confirm pushing commits that are not the task's, or creating a branch on the remote.",
          409,
        );
      }
      return push
        ? services.mrs.mergeAndPush({
            ...input,
            pushLocalCommits,
            createRemoteBranch,
            by: actorName(ctx.meta.actor),
          })
        : services.tasks.merge({ ...input, by: actorName(ctx.meta.actor) });
    },
    // A fast-forward only, never forced: an agent asks through the owner's approval policy.
    "tasks.updateTarget": (input, ctx) =>
      services.mrs.updateTarget({ ...input, by: actorName(ctx.meta.actor) }),
    "tasks.syncBase": (input, ctx) =>
      services.mrs.syncBase({
        ...input,
        by: actorName(ctx.meta.actor),
        // The task's own agent asks mid-turn; the clean-worktree check still guards its files.
        fromOwnTask: ctx.meta.actor.kind === "agent" && ctx.meta.task === input.id,
      }),
    "tasks.shipOptions": async (input) => {
      const queued = services.queuedMerges.get(input.id);
      return { ...(await services.mrs.shipOptions(input.id)), ...(queued === undefined ? {} : { queued }) };
    },
    // Owner only: an agent or the captain never decides to merge ahead of a check.
    "tasks.queueMerge": async ({ id, ...input }, ctx) => {
      if (ctx.meta.actor.kind !== "owner") {
        throw new UserError("Only the owner can queue a merge for when the checks pass.", 409);
      }
      return {
        queued: await services.queuedMerges.request({ task: id, ...input, by: actorName(ctx.meta.actor) }),
      };
    },
    "tasks.cancelQueuedMerge": async (input, ctx) => {
      if (ctx.meta.actor.kind !== "owner") {
        throw new UserError("Only the owner can cancel a queued merge.", 409);
      }
      services.queuedMerges.cancel(input.id);
      return { ok: true as const };
    },
    "tasks.push": (input, ctx) => services.mrs.push(input.id, input.deleteAfter, actorName(ctx.meta.actor)),
    "tasks.resolveShip": async (input, ctx) => ({
      task: await services.pendingShips.request({
        ...input,
        by: actorName(ctx.meta.actor),
        agent: ctx.meta.actor.kind === "agent",
      }),
    }),
    "tasks.addRepo": (input, ctx) => {
      mayReach(services.store, ctx, input.id);
      return services.tasks.addRepo({ ...input, byOwner: ctx.meta.actor.kind === "owner" });
    },
    "tasks.removeRepo": (input, ctx) => {
      mayReach(services.store, ctx, input.id);
      if (ctx.meta.actor.kind === "agent" && input.discard === true) {
        throw new UserError("Only the owner throws away uncommitted work. Ask the owner.", 409);
      }
      return services.tasks.removeRepo({
        id: input.id,
        project: input.project,
        discard: input.discard === true,
      });
    },
    "tasks.look": (input, ctx) => {
      mayReach(services.store, ctx, input.id);
      return lookAtTask(services.tasks.get(input.id), input);
    },
    "tasks.tell": (input, ctx) =>
      services.captainTell.tell(input, {
        kind: ctx.meta.actor.kind === "agent" ? "agent" : "owner",
        ...(ctx.meta.actor.kind === "agent" ? { id: ctx.meta.actor.id } : {}),
        task: ctx.meta.task,
      }),
    "tasks.cancelShip": async (input) => ({ task: services.pendingShips.cancel(input.id) }),
    "tasks.branches": (input) => services.tasks.branches(input.id),
    "tasks.diff": (input) => services.tasks.diff(input.id),
    "tasks.mergeOrder": (input) => services.mrs.order(input.id),
    "tasks.setMergeOrder": (input) => services.mrs.setOrder(input.id, input.order),
    "tasks.openMrs": (input, ctx) =>
      services.mrs.open(input.id, { into: input.into, targets: input.targets }, actorName(ctx.meta.actor)),
    "tasks.refreshMrs": (input) => services.mrs.refresh(input.id),
    "tasks.mergeMrs": (input, ctx) =>
      services.mrs.merge(input.id, ctx.meta.actor.kind === "agent" ? "poll" : "owner"),
    "tasks.markMerged": (input) => services.mrs.markMerged(input),
    "tasks.changeBranch": (input, ctx) =>
      changeTaskBranch(
        {
          tasks: services.store.tasks,
          working: (task) => services.runs.working(task),
          locks: services.runs.locks,
          room: services.room,
          commitBy: async (target, project, agent) => {
            const [author, on] = await Promise.all([
              orgIdentity(config, target.org),
              attributionOf(config, target),
            ]);
            return commitBy(author, target.id, agent, on.repos[project] !== false);
          },
          isRoot: async (agent) => {
            const stored = await services.agentStore.get(agent);
            return stored?.ok === true && stored.agent.frontmatter.scope === "root";
          },
        },
        input,
        ctx.meta,
      ),
    "tasks.remove": async (input) => {
      await services.tasks.remove(input.id, input.force === true, input.confirm);
      return { removed: input.id };
    },
    "tasks.split": async (input, ctx) => {
      const children = [];
      for (const c of input.children) {
        const captured = await services.secretService.capture(c.text);
        children.push({ ...c, text: captured.text });
      }
      return { children: await services.tasks.split({ ...input, children, from: ctx.meta.task }) };
    },
    "team.add": (input) =>
      services.tasks.addToTeam(input.task, input.agent, input.lead === undefined ? {} : { lead: input.lead }),
    "team.remove": (input) => services.tasks.removeFromTeam(input.task, input.agent),
    "tasks.setLead": (input, ctx) =>
      services.tasks.setLead({
        ...input,
        by: ctx.meta.actor.kind === "owner" ? { kind: "owner" } : { kind: "agent", id: ctx.meta.actor.id },
      }),
    "tasks.staff": (input) => services.autonomy.staff(input),
    "tasks.addAgent": (input) =>
      services.tasks.addToTeam(input.id, input.agent, input.lead === undefined ? {} : { lead: input.lead }),
    "tasks.removeAgent": (input) => services.tasks.removeFromTeam(input.id, input.agent),
    "team.swap": (input) => services.tasks.swapInTeam(input.task, input.agent, input.with),
    "team.set": (input) => services.tasks.setOverride(input),

    "uploads.create": (input, ctx) => services.tasks.uploadFile(input.path, ctx.meta.task),
    "room.send": async (input, ctx) => {
      services.tasks.get(input.task);
      // Secrets are saved and swapped for references before the text reaches an agent or the room.
      const captured = await services.secretService.capture(input.text);
      // The owner asking for a skill or an MCP server gets one approval card, not a turn of the agent.
      if (ctx.meta.actor.kind === "owner") {
        const asked = await services.installRequests.offer({
          task: input.task,
          text: captured.text,
          agent: input.agent,
        });
        if (asked !== undefined) {
          noteSecrets(services, input.task, captured.saved);
          return { item: asked };
        }
      }
      const item = await services.tasks.send({ ...input, text: captured.text, from: ctx.meta.task });
      noteSecrets(services, input.task, captured.saved);
      return { item };
    },
    "room.cancel": async (input) => ({ cancelled: await services.tasks.cancel(input.task, input.agent) }),
    "room.sendNow": async (input) => {
      services.tasks.get(input.task);
      return { item: await services.runs.sendNow(input.task, input.item) };
    },
    "room.unqueue": async (input) => {
      services.tasks.get(input.task);
      return { item: services.runs.unqueue(input.task, input.item) };
    },
    "room.permission": async (input) => ({
      item: services.tasks.answerPermission(input.task, input.item, input.option),
    }),
    "room.choose": async (input) => ({
      item: await services.tasks.answerChoice(input.task, input.item, input.option),
    }),
    "tasks.plan": (input) => services.tasks.plan(input.id),
    "room.items": async (input) =>
      services.tasks.items(input.task, input.limit, input.beforeSeq, input.afterSeq),
    "room.around": async (input) => services.tasks.itemsAround(input.task, input.item, input.limit),
    "room.search": async (input) => services.tasks.searchRooms(input.query, input.limit, input.org),
    "room.files": (input) => services.tasks.searchFiles(input.task, input.query),
    "processes.stop": async (input) => {
      services.tasks.get(input.task);
      return { process: await services.processes.stop(input.task, input.id, "owner") };
    },
    "tasks.terminal.open": (input) => services.openTaskTerminal(input.task),
    "containers.list": async (input) => {
      if (input.task !== undefined) services.tasks.get(input.task);
      const reason = services.containers.reason();
      return {
        available: services.containers.available(),
        ...(reason === undefined ? {} : { reason }),
        containers: services.containers.list(input.task),
      };
    },
    "containers.images.allow": async (input, ctx) => {
      await requireConfigFile(config);
      const { images, org_images } = (await config.settings()).containers;
      const meta = { command: ctx.command, meta: ctx.meta };
      if (input.org === undefined) {
        if (images.some((image) => sameImage(image, input.image))) return { images };
        const next = [...images, input.image];
        await config.setSettings(
          { containers: { images: next } },
          { ...meta, summary: `allowed the image ${input.image} for service containers` },
        );
        return { images: next };
      }
      const here = org_images[input.org] ?? [];
      // Allowed everywhere already: nothing to add to the workspace.
      if (
        here.some((image) => sameImage(image, input.image)) ||
        images.some((image) => sameImage(image, input.image))
      ) {
        return { images: here };
      }
      const next = [...here, input.image];
      await config.setSettings(
        { containers: { org_images: { ...org_images, [input.org]: next } } },
        { ...meta, summary: `allowed the image ${input.image} for service containers in ${input.org}` },
      );
      return { images: next };
    },
    "containers.images.remove": async (input, ctx) => {
      await requireConfigFile(config);
      const { images, org_images } = (await config.settings()).containers;
      const meta = { command: ctx.command, meta: ctx.meta };
      if (input.org === undefined) {
        const next = images.filter((image) => !sameImage(image, input.image));
        if (next.length === images.length)
          throw new UserError(`${input.image} is not in the allowed images.`, 404);
        await config.setSettings(
          { containers: { images: next } },
          { ...meta, summary: `stopped allowing the image ${input.image} for service containers` },
        );
        return { images: next };
      }
      const here = org_images[input.org] ?? [];
      const next = here.filter((image) => !sameImage(image, input.image));
      if (next.length === here.length) {
        throw new UserError(`${input.image} is not in the images allowed in ${input.org}.`, 404);
      }
      const { [input.org]: _removed, ...others } = org_images;
      await config.setSettings(
        { containers: { org_images: next.length === 0 ? others : { ...org_images, [input.org]: next } } },
        {
          ...meta,
          summary: `stopped allowing the image ${input.image} for service containers in ${input.org}`,
        },
      );
      return { images: next };
    },
    "containers.preview.build": async ({ task, ...rest }, ctx) => ({
      process: await services.containers.previewBuild(task, actingAgent(services, task, ctx), rest),
    }),
    "containers.preview.run": async ({ task, ...rest }, ctx) => ({
      container: await services.containers.previewRun(task, actingAgent(services, task, ctx), rest),
    }),
    "containers.services.start": async ({ task, ...rest }, ctx) => {
      const result = await services.containers.serviceStart(task, actingAgent(services, task, ctx), rest);
      if (result.status !== "started") throw new UserError("The service did not start.");
      return { container: result.container };
    },
    "containers.stop": async (input, ctx) => ({
      container: await services.containers.stop(
        input.task,
        input.name,
        ctx.meta.actor.kind === "owner" ? "owner" : "agent",
      ),
    }),
    // Phase 2b commands, filled in by the 2b work. Each answers 501 until then.
    "tasks.link": (input) => services.tasks.link(input),
    "tasks.unlink": (input) => services.tasks.unlink(input),
    "room.fresh": async (input) => ({ item: await services.tasks.fresh(input.task, input.agent) }),
    "room.approve": (input, ctx) =>
      answerCard(services, ctx, input, () =>
        services.admin.decide(
          input.task,
          input.item,
          input.decision,
          input.always === undefined
            ? undefined
            : {
                scope: input.always.scope,
                change: { command: ctx.command, meta: ctx.meta, summary: "saved an always-allow rule" },
              },
          { by: ctx.meta.actor.kind === "agent" ? "captain" : "owner", reason: input.reason },
        ),
      ),
    "room.secret": async (input) => ({
      item: await services.admin.answerSecret(input.task, input.item, input.value),
    }),
    "room.cardAction": (input, ctx) => {
      if (input.confirmChecks !== undefined && ctx.meta.actor.kind !== "owner") {
        throw new UserError("Only the owner can merge past a failed check.", 409);
      }
      return services.cardActions.act({
        ...input,
        by: actorName(ctx.meta.actor),
        agent: ctx.meta.actor.kind === "agent",
      });
    },
    "room.answerQuestion": (input, ctx) =>
      answerCard(services, ctx, input, () =>
        services.tasks.answerQuestion(input.task, input.item, input.choice),
      ),
    "room.answerAsk": (input, ctx) =>
      answerCard(services, ctx, input, () => services.tasks.answerAsk(input.task, input.item, input.answers)),
    "secrets.list": () => services.secretService.list(),
    "secrets.save": (input) => services.secretService.save(input),
    "secrets.remove": async (input) => {
      await services.secretService.remove(input.name);
      return { removed: input.name };
    },
    // The passphrase is used once to encrypt the export: not logged, kept or put in an error.
    "secrets.exportKey": (input) => services.keyExports.export(input.passphrase),
    // The passphrase opens the export once. The key inside goes to the helper in this one job and
    // nowhere else: neither is logged, kept, returned or put in an error.
    "secrets.restoreKey": (input) =>
      restoreKey(input, {
        secrets: services.secrets,
        writeKey: (key) => hostLink.call("secretsKey.restore", { key }, KEY_RESTORE_TIMEOUT_MS),
      }),
    "history.list": (input) => config.historyEntries(input.limit),
    "history.undo": async (input, ctx) => {
      const done = await config.undo(input.commit, {
        command: ctx.command,
        meta: ctx.meta,
        summary: `undid change ${input.commit.slice(0, 7)}`,
      });
      services.admin.markUndone(done.undone);
      return { commit: done.commit, summary: done.summary };
    },
    "settings.get": () => config.settings(),
    "settings.set": async (input, ctx) => {
      await requireConfigFile(config);
      const current = await config.settings();
      const compactAt = input.context?.compact_at ?? current.context.compact_at;
      const compactTarget = input.context?.compact_target ?? current.context.compact_target;
      if (compactTarget >= compactAt) {
        throw new UserError("compact_target must be lower than compact_at.", 400);
      }
      if (typeof input.memory?.housekeeper === "string") {
        const id = input.memory.housekeeper;
        if ((await services.agentStore.get(id)) === undefined) {
          throw new UserError(`There is no agent @${id}.`, 404);
        }
      }
      const patch = {
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.limits === undefined ? {} : { limits: input.limits }),
        ...(input.turns === undefined ? {} : { turns: input.turns }),
        ...(input.resume === undefined ? {} : { resume: input.resume }),
        ...(input.commits === undefined ? {} : { commits: input.commits }),
        ...(input.wiki === undefined ? {} : { wiki: input.wiki }),
        ...(input.rooms === undefined ? {} : { rooms: input.rooms }),
        ...(input.memory === undefined ? {} : { memory: input.memory }),
        ...(input.editor === undefined ? {} : { editor: input.editor }),
        ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }),
        ...(input.notifications === undefined ? {} : { notifications: input.notifications }),
        ...(input.containers === undefined ? {} : { containers: input.containers }),
        ...(input.budgets === undefined ? {} : { budgets: mergeBudgets(current.budgets, input.budgets) }),
      };
      await config.setSettings(patch, {
        command: ctx.command,
        meta: ctx.meta,
        summary: `changed ${describePatch(patch)}`,
      });
      // Limits apply live: starts waiting in line may fit now.
      if (patch.limits !== undefined) await services.runs.limitsChanged();
      // Budgets apply live: a raised one re-arms its alerts, a lowered one may fire now.
      if (patch.budgets !== undefined) await services.budgets.recheck();
      return config.settings();
    },
    "policy.set": async (input, ctx) => {
      ownerOnlyPolicy(ctx.meta);
      await requireConfigFile(config);
      await config.setSettings(
        { policy: input },
        {
          command: ctx.command,
          meta: ctx.meta,
          summary: `changed the approval policy: ${describePatch({ policy: input })}`,
        },
      );
      return config.settings();
    },
    "policy.removeRule": async (input, ctx) => {
      ownerOnlyPolicy(ctx.meta);
      await requireConfigFile(config);
      const { policy } = await config.settings();
      const rules = policy.rules.filter((r) => !sameRule(r, input));
      if (rules.length === policy.rules.length) throw new UserError("That rule does not exist.", 404);
      await config.setSettings(
        { policy: { rules } },
        {
          command: ctx.command,
          meta: ctx.meta,
          summary: `removed the rule for @${input.agent} to run ${input.command} for ${input.task ?? `org ${input.org}`}`,
        },
      );
      return config.settings();
    },
    "policy.cardStats": async (input) => cardStats(services.store.room, input.days),
    "permissions.list": async () => allowances(services),
    "permissions.revoke": async (input) => {
      services.store.permissions.revoke(input.task, input.kind);
      return allowances(services);
    },
    "boss.chat": (input) => openBossChat(chatDeps(), input.fresh === true),
    "chats.create": (input) => openChat(chatDeps(), input.agent),
    "chats.rename": async (input) => services.tasks.renameChat(input.id, input.title),
    "audit.list": async (input) => services.store.permissions.list(input),
    "cleanup.preview": async (input) =>
      services.cleanup.preview(input.days ?? (await config.settings()).cleanup.after_days, input.cachesOnly),
    "cleanup.run": async (input, ctx) =>
      services.cleanup.run(
        input.tasks,
        input.days ?? (await config.settings()).cleanup.after_days,
        actorName(ctx.meta.actor),
        input.cachesOnly,
      ),
    "health.run": () => (health ? health.run() : notBuilt()),
    "health.checkAll": () => (health ? health.checkAll() : notBuilt()),
    "health.check": (input) => (health ? health.check(input.id) : notBuilt()),
    "health.fix": (input, ctx) =>
      health ? health.fix(input.id, ctx.meta.actor.kind === "owner" ? "owner" : "agent") : notBuilt(),
    "system.version": () => (system ? system.version() : notBuilt()),
    "system.update": (input) => (system ? system.update(input.when) : notBuilt()),
    "decisions.ask": (input) => services.decisions.ask(input),
    "decisions.recent": async (input) => services.decisions.recent(input.limit, input.offset),
    "decisions.correct": async (input) => services.decisions.correct(input),
    "decisions.get": async (input) => services.decisions.get(input.id),
    "decisions.label": async (input) => services.decisions.label(input),
    "decisions.eval": async (input, ctx) => {
      if (ctx.meta.actor.kind !== "owner")
        throw new UserError("Only the owner runs the decision evals.", 409);
      return services.decisions.runEvals(input.use);
    },
    "decisions.slots": async () => services.decisions.slots(),
    "decisions.status": () => services.decisions.status(),
    "decisions.set": (input, ctx) => services.decisions.set(input, ctx.meta, ctx.command),
    "decisions.install": () => services.decisions.install(),
    "memory.search": async (input) => {
      const scopes = input.scopes ?? services.memory.scopesInUse();
      return services.memory.search(input.query, { scopes, status: input.status, limit: input.limit });
    },
    "memory.list": async (input) => services.memory.list(input),
    "memory.add": (input, ctx) => services.memory.add(input, ctx.meta.actor),
    "memory.edit": async (input, ctx) =>
      services.memory.edit(input.id, { text: input.text, scope: input.scope }, ctx.meta.actor),
    "memory.approve": async (input, ctx) => services.memory.approve(input.id, ctx.meta.actor, input.reason),
    "memory.reject": async (input, ctx) => services.memory.reject(input.id, ctx.meta.actor, input.reason),
    "memory.forget": async (input, ctx) => services.memory.forget(input.id, ctx.meta.actor, input.reason),
    "memory.undo": async (input, ctx) => services.memory.undo(input.event, ctx.meta.actor),
    "memory.extract": async (input) => services.extraction.extract(input.task),
    "memory.promote": async (input, ctx) => services.promotion.promote(input.id, ctx.meta.actor),
    "memory.pin": async (input, ctx) => services.memory.pin(input.id, input.pinned, ctx.meta.actor),
    "memory.events": async (input) => services.memory.events(input),
    "memory.approveAll": async (input, ctx) => ({
      count: services.memory.decideAll("approve", input.ids, ctx.meta.actor),
    }),
    "memory.rejectAll": async (input, ctx) => ({
      count: services.memory.decideAll("reject", input.ids, ctx.meta.actor),
    }),
    "memory.records": async (input) =>
      services.memory.project.records({ query: input.query, project: input.project, limit: input.limit }),
    "memory.record": async (input) => (await services.memory.project.recordNow(input.task)) ?? null,
    "memory.brief": async (input) => services.memory.project.brief(input.project),
    "memory.restoreBrief": async (input) =>
      services.memory.project.restoreBrief(input.project, input.version),
    "memory.buildBrief": async (input) => services.extraction.buildBrief(input.project),
    "memory.threads": async (input) =>
      services.memory.project.threads({
        ...(input.project === undefined ? {} : { projects: [input.project] }),
        status: input.status,
        task: input.task,
        limit: input.limit,
      }),
    "memory.closeThread": async (input) =>
      services.memory.project.closeThread(input.id, "owner", input.reason),
    "memory.reopenThread": async (input) => services.memory.project.reopenThread(input.id),
    "budgets.status": () => services.budgets.status(),
    "usage.summary": async (input) => services.usage.summary(input.filters, input.tz),
    "usage.breakdown": async (input) => services.usage.breakdown(input),
    "usage.turns": async (input) => services.usage.turns(input.filters, input.limit),
    "usage.receipt": async (input) => services.usage.receipt(input.task),
    "usage.agentReceipt": async (input) => services.usage.agentReceipt(input),
    "usage.prices": () => services.usage.prices(),
    "usage.setPrice": async (input, ctx) => {
      await requireConfigFile(config);
      return services.usage.setPrice(input.model, input.price, {
        command: ctx.command,
        meta: ctx.meta,
        summary:
          input.price === null
            ? `removed the price of ${input.model}`
            : `set the price of ${input.model} to $${input.price.input} in, $${input.price.output} out per million tokens`,
      });
    },
  };
}

/** Tells the room which secrets were saved from the owner's text. */
/**
 * An answer to a card. The owner's click goes straight through. The captain's answer is keyed by the
 * card (G1): a second answer to the same card changes nothing and says `refused`, not an error.
 */
async function answerCard(
  services: Services,
  ctx: CommandContext,
  card: { task: string; item: string },
  answer: () => Promise<RoomItem>,
): Promise<CommandOutput<"room.answerAsk">> {
  if (ctx.meta.actor.kind !== "agent") return { item: await answer() };
  let given: RoomItem | undefined;
  const result = await answerOnce(services.captain.repo, new Date(), card, async () => {
    given = await answer();
  });
  if (result.answered && given !== undefined) return { item: given };
  const item = services.room.get(card.task, card.item);
  if (item === undefined) throw new UserError(`There is no card ${card.item} in ${card.task}.`, 404);
  return { item, refused: !result.answered && result.why === "in-flight" ? "in-flight" : "already-answered" };
}

function noteSecrets(services: Services, task: string, saved: readonly string[]): void {
  for (const ref of saved) {
    services.room.post(task as TaskId, `secret-note:${randomUUID()}`, {
      type: "system",
      level: "info",
      text: `Saved a secret as ${ref}; the agent sees only the reference`,
    });
  }
}

/** Settings are written into majhi.yaml, which starts with the workspace roots. */
/**
 * The agent a container process belongs to: the one that called the command, else the task's lead,
 * so the agent that is woken when a build ends is one of the team.
 */
function actingAgent(services: Services, task: string, ctx: CommandContext): string {
  if (ctx.meta.actor.kind === "agent") return ctx.meta.actor.id;
  // A task with nobody on it: the process belongs to majhi, and no agent is woken when it ends.
  return services.tasks.get(task).team[0] ?? "majhi";
}

async function requireConfigFile(config: ConfigService): Promise<void> {
  if (!(await config.sections()).exists) throw new UserError("Pick workspace roots first.", 409);
}

/**
 * The budget maps `settings.set` writes: the ones already there, with the patch's added, changed or
 * (null) removed. The writer replaces a whole map, so the other budgets must be in it.
 */
function mergeBudgets(current: BudgetsSettings, patch: BudgetsPatch): Partial<BudgetsSettings> {
  const out: Partial<BudgetsSettings> = {};
  for (const scope of ["orgs", "accounts"] as const) {
    const changes = patch[scope];
    if (changes === undefined) continue;
    const merged: Record<string, Budget> = { ...current[scope] };
    for (const [id, budget] of Object.entries(changes)) {
      if (budget === null) delete merged[id];
      else merged[id] = budget;
    }
    out[scope] = merged;
  }
  return out;
}

/** `limits.agents_max to 3, context.compact_at to 0.7`. */
function describePatch(patch: Record<string, object | undefined>): string {
  const parts: string[] = [];
  for (const [section, fields] of Object.entries(patch)) {
    for (const [key, value] of Object.entries(fields ?? {})) {
      parts.push(`${section}.${key} to ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
  }
  return parts.join(", ") || "nothing";
}

/** The CLI "allow for this task" choices with each task's title. A deleted task shows its id. */
function allowances(services: Services) {
  return services.store.permissions.allowances().map((a) => ({
    ...a,
    title: services.store.tasks.get(a.task)?.title ?? a.task,
  }));
}

/** Placeholder for a Phase 2b command that is not built yet. */
async function notBuilt(): Promise<never> {
  throw new UserError("This command is not built yet.", 501);
}

/** Roots the server cannot see, because they are not mounted yet. */
async function findUnmounted(roots: readonly string[]): Promise<string[]> {
  const visible = await Promise.all(roots.map((root) => isDirectory(root)));
  return roots.filter((_, i) => !visible[i]);
}

/**
 * Asks the host helper to remount when a root is not visible. Falls back to
 * `manual` (the owner runs `make up`) when no helper is connected, when it
 * cannot run Docker, or when it does not take the job.
 */
export async function requestRemount(hostLink: HostLink, unmounted: readonly string[]): Promise<Remount> {
  if (unmounted.length === 0) return "not-needed";
  const status = hostLink.status();
  if (!status.connected || status.info?.canRemount !== true) return "manual";
  try {
    await hostLink.call("remount", {});
    return "restarting";
  } catch (err) {
    if (err instanceof HostOfflineError || err instanceof HostJobError) return "manual";
    throw err;
  }
}

/** The approval policy is the owner's alone: an agent never changes what it may do without asking. */
function ownerOnlyPolicy(meta: CommandMeta): void {
  if (meta.actor.kind !== "owner") throw new UserError("Only the owner changes the approval policy.", 409);
}

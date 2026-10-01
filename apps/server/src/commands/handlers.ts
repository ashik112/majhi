import { randomUUID } from "node:crypto";
import type {
  Budget,
  BudgetsPatch,
  BudgetsSettings,
  CommandMeta,
  CommandName,
  CommandOutput,
  commands,
  Remount,
  TaskId,
} from "@majhi/shared";
import { RESTART_COMMAND, sameImage } from "@majhi/shared";
import type { z } from "zod";
import { openBossChat, openChat } from "../admin/boss.ts";
import { sameRule } from "../admin/policy.ts";
import { scheduleHandlers } from "../automation/handlers.ts";
import { triggerHandlers } from "../automation/triggers/handlers.ts";
import type { ConfigService } from "../config/service.ts";
import { editorPath } from "../editor/allowed.ts";
import { UserError } from "../errors.ts";
import { isDirectory } from "../fs.ts";
import type { HealthService } from "../health/service.ts";
import { HostJobError, type HostLink, HostOfflineError } from "../host/link.ts";
import { fetchPublicProfile, setGitAccount, useSavedLogin } from "../orgs/gitAccount.ts";
import { type AdoptDeps, useGitLogin } from "../orgs/gitLogin.ts";
import { attributionOf, orgIdentity } from "../runs/attribution.ts";
import { commitBy } from "../runs/checkpoint.ts";
import { classifyHost } from "../scan/remote.ts";
import type { RepoScanner } from "../scan/scanner.ts";
import { sshConfigHosts } from "../scan/sshConfig.ts";
import type { Services } from "../services.ts";
import type { SshHostProbe } from "../ssh/hosts.ts";
import type { SystemService } from "../system/service.ts";
import { actorName } from "../tasks/cards.ts";
import { changeTaskBranch } from "../tasks/change-branch.ts";
import { readReport } from "../tasks/report.ts";

/** Loading keys and asking the Keychain can take a few seconds. */
const SSH_CALL_TIMEOUT_MS = 40_000;

/** `gh auth token` is quick, but the helper may be busy. */
const GIT_TOKEN_TIMEOUT_MS = 20_000;

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
  const viewOf = async (id: string) => {
    const org = (await orgs.list()).find((o) => o.id === id);
    if (org === undefined) throw new UserError(`Org "${id}" does not exist.`, 404);
    return org;
  };
  return {
    ...scheduleHandlers(services.automation.schedules),
    ...triggerHandlers(services.automation.triggers),

    "config.get": async () => (await config.load()).state,

    "repos.scan": async (input) => {
      const loaded = await config.load();
      if (loaded.state.status !== "loaded") {
        return { roots: [], scannedAt: new Date().toISOString(), durationMs: 0 };
      }
      return scanner.scan(
        { config: loaded.state.config, projectPaths: loaded.projectPaths, hostHome: config.paths.hostHome },
        input.refresh === true,
      );
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
              : { identity: org.identity, accounts: org.git_accounts ?? [] };
          },
          logins: () => services.gitLogins.list().then((r) => r.hosts),
          adopt: async (via, host) => (await useGitLogin(adoptDeps(ctx), { id: input.id, via, host })).ref,
          saveSecret: (secret) => services.secretService.save(secret),
          publicProfile: fetchPublicProfile,
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
        throw new UserError("Only the owner can use the Mac's saved login. Ask them to click it.", 409);
      }
      return useSavedLogin(
        {
          org: async (id) => {
            const org = (await config.sections()).orgs[id];
            return org === undefined
              ? undefined
              : { identity: org.identity, accounts: org.git_accounts ?? [] };
          },
          readSecret: async (host, account) =>
            (await hostLink.call("git.credential", { host, username: account }, GIT_TOKEN_TIMEOUT_MS)).secret,
          probe: async (url, headers) =>
            (await fetch(url, { headers, signal: AbortSignal.timeout(8000), redirect: "error" })).status,
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

    "projects.pushRoute": (input) => services.mrs.pushRoute(input.id),

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
    "projects.register": (input, ctx) => services.projects.register(input, ctx.command, ctx.meta),
    "projects.update": (input, ctx) => services.projects.update(input, ctx.command, ctx.meta),
    "projects.remove": async (input, ctx) => {
      await services.projects.remove(input.id, ctx.command, ctx.meta);
      return { removed: input.id };
    },

    "tasks.list": async (input) => services.tasks.list(input.includeDone === true),
    "tasks.get": async (input) => services.tasks.get(input.id),
    "tasks.create": async (input, ctx) => {
      // A secret in the task text must not reach TASK.md or the agent.
      const captured = await services.secretService.capture(input.text);
      const task = await services.tasks.create({ ...input, text: captured.text, from: ctx.meta.task });
      noteSecrets(services, task.id, captured.saved);
      return task;
    },
    "tasks.report": async (input) => (await readReport(services.tasks.get(input.id).folder)) ?? null,
    "tasks.start": (input, ctx) =>
      services.tasks.start(input.id, ctx.meta.actor.kind === "agent" ? `@${ctx.meta.actor.id}` : "owner"),
    "tasks.stop": (input) => services.tasks.stop(input.id),
    "tasks.update": (input) => services.tasks.update(input),
    "tasks.close": (input, ctx) =>
      services.tasks.close(input.id, {
        by: actorName(ctx.meta.actor),
        agent: ctx.meta.actor.kind === "agent",
        whenUnshipped: input.unshipped ?? "refuse",
      }),
    "tasks.reopen": (input) => services.tasks.reopen(input.id),
    "tasks.merge": ({ push, ...input }, ctx) =>
      push
        ? services.mrs.mergeAndPush({ ...input, by: actorName(ctx.meta.actor) })
        : services.tasks.merge({ ...input, by: actorName(ctx.meta.actor) }),
    "tasks.updateTarget": (input, ctx) => {
      if (ctx.meta.actor.kind === "agent") {
        throw new UserError(
          "Only the owner can update a branch in their checkout. Ask them to click Update in Ship.",
          409,
        );
      }
      return services.mrs.updateTarget({ ...input, by: "owner" });
    },
    "tasks.shipOptions": (input) => services.mrs.shipOptions(input.id),
    "tasks.push": (input, ctx) => services.mrs.push(input.id, input.deleteAfter, actorName(ctx.meta.actor)),
    "tasks.resolveShip": async (input, ctx) => ({
      task: await services.pendingShips.request({ ...input, by: actorName(ctx.meta.actor) }),
    }),
    "tasks.cancelShip": async (input) => ({ task: services.pendingShips.cancel(input.id) }),
    "tasks.branches": (input) => services.tasks.branches(input.id),
    "tasks.diff": (input) => services.tasks.diff(input.id),
    "tasks.mergeOrder": (input) => services.mrs.order(input.id),
    "tasks.setMergeOrder": (input) => services.mrs.setOrder(input.id, input.order),
    "tasks.openMrs": (input, ctx) => services.mrs.open(input.id, input.into, actorName(ctx.meta.actor)),
    "tasks.refreshMrs": (input) => services.mrs.refresh(input.id),
    "tasks.mergeMrs": (input) => services.mrs.merge(input.id, "owner"),
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
      await services.tasks.remove(input.id, input.force === true);
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
      const item = await services.tasks.send({ ...input, text: captured.text, from: ctx.meta.task });
      noteSecrets(services, input.task, captured.saved);
      return { item };
    },
    "room.cancel": async (input) => ({ cancelled: await services.tasks.cancel(input.task, input.agent) }),
    "room.permission": async (input) => ({
      item: services.tasks.answerPermission(input.task, input.item, input.option),
    }),
    "room.choose": async (input) => ({
      item: await services.tasks.answerChoice(input.task, input.item, input.option),
    }),
    "tasks.plan": (input) => services.tasks.plan(input.id),
    "room.items": async (input) => services.tasks.items(input.task, input.limit, input.beforeSeq),
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
      const { images } = (await config.settings()).containers;
      if (images.some((image) => sameImage(image, input.image))) return { images };
      const next = [...images, input.image];
      await config.setSettings(
        { containers: { images: next } },
        {
          command: ctx.command,
          meta: ctx.meta,
          summary: `allowed the image ${input.image} for service containers`,
        },
      );
      return { images: next };
    },
    "containers.images.remove": async (input, ctx) => {
      await requireConfigFile(config);
      const { images } = (await config.settings()).containers;
      const next = images.filter((image) => !sameImage(image, input.image));
      if (next.length === images.length)
        throw new UserError(`${input.image} is not in the allowed images.`, 404);
      await config.setSettings(
        { containers: { images: next } },
        {
          command: ctx.command,
          meta: ctx.meta,
          summary: `stopped allowing the image ${input.image} for service containers`,
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
    "room.approve": async (input, ctx) => ({
      item: await services.admin.decide(
        input.task,
        input.item,
        input.decision,
        input.always === undefined
          ? undefined
          : {
              scope: input.always.scope,
              change: { command: ctx.command, meta: ctx.meta, summary: "saved an always-allow rule" },
            },
      ),
    }),
    "room.secret": async (input) => ({
      item: await services.admin.answerSecret(input.task, input.item, input.value),
    }),
    "room.cardAction": (input, ctx) =>
      services.cardActions.act({
        ...input,
        by: actorName(ctx.meta.actor),
        agent: ctx.meta.actor.kind === "agent",
      }),
    "room.answerQuestion": async (input) => ({
      item: await services.tasks.answerQuestion(input.task, input.item, input.choice),
    }),
    "room.answerAsk": async (input) => ({
      item: await services.tasks.answerAsk(input.task, input.item, input.answers),
    }),
    "secrets.list": () => services.secretService.list(),
    "secrets.save": (input) => services.secretService.save(input),
    "secrets.remove": async (input) => {
      await services.secretService.remove(input.name);
      return { removed: input.name };
    },
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
        ...(input.resume === undefined ? {} : { resume: input.resume }),
        ...(input.commits === undefined ? {} : { commits: input.commits }),
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
      services.cleanup.preview(input.days ?? (await config.settings()).cleanup.after_days),
    "cleanup.run": async (input, ctx) =>
      services.cleanup.run(
        input.tasks,
        input.days ?? (await config.settings()).cleanup.after_days,
        actorName(ctx.meta.actor),
      ),
    "health.run": () => (health ? health.run() : notBuilt()),
    "health.fix": (input) => (health ? health.fix(input.id) : notBuilt()),
    "system.version": () => (system ? system.version() : notBuilt()),
    "system.update": (input) => (system ? system.update(input.when) : notBuilt()),
    "decisions.ask": (input) => services.decisions.ask(input),
    "decisions.recent": async (input) => services.decisions.recent(input.limit, input.offset),
    "decisions.correct": async (input) => services.decisions.correct(input),
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

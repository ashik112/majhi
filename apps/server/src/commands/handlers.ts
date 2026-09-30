import { randomUUID } from "node:crypto";
import type { CommandMeta, CommandName, CommandOutput, commands, Remount, TaskId } from "@majhi/shared";
import { RESTART_COMMAND } from "@majhi/shared";
import type { z } from "zod";
import { openBossChat } from "../admin/boss.ts";
import type { ConfigService } from "../config/service.ts";
import { UserError } from "../errors.ts";
import { isDirectory } from "../fs.ts";
import type { HealthService } from "../health/service.ts";
import { HostJobError, type HostLink, HostOfflineError } from "../host/link.ts";
import type { RepoScanner } from "../scan/scanner.ts";
import type { Services } from "../services.ts";
import type { SshHostProbe } from "../ssh/hosts.ts";
import type { SystemService } from "../system/service.ts";

/** Loading keys and asking the Keychain can take a few seconds. */
const SSH_CALL_TIMEOUT_MS = 40_000;

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
  return {
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
    "accounts.models": (input) => accounts.models(input.id, input.refresh === true),

    "agents.list": () => agents.list(),
    "agents.create": (input, ctx) => agents.create(input.id, input, ctx.command, ctx.meta),
    "agents.update": (input, ctx) => agents.update(input.id, input, ctx.command, ctx.meta),
    "agents.edit": (input, ctx) =>
      agents.edit(input.id, { set: input.set, instructions: input.instructions }, ctx.command, ctx.meta),
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
    "tasks.create": async (input) => {
      // A secret in the task text must not reach TASK.md or the agent.
      const captured = await services.secretService.capture(input.text);
      const task = await services.tasks.create({ ...input, text: captured.text });
      noteSecrets(services, task.id, captured.saved);
      return task;
    },
    "tasks.start": (input) => services.tasks.start(input.id),
    "tasks.stop": (input) => services.tasks.stop(input.id),
    "tasks.update": (input) => services.tasks.update(input),
    "tasks.close": (input) => services.tasks.close(input.id),
    "tasks.remove": async (input) => {
      await services.tasks.remove(input.id, input.force === true);
      return { removed: input.id };
    },
    "tasks.split": async (input) => {
      const children = [];
      for (const c of input.children) {
        const captured = await services.secretService.capture(c.text);
        children.push({ ...c, text: captured.text });
      }
      return { children: await services.tasks.split({ ...input, children }) };
    },
    "team.add": (input) =>
      services.tasks.addToTeam(input.task, input.agent, input.lead === undefined ? {} : { lead: input.lead }),
    "team.remove": (input) => services.tasks.removeFromTeam(input.task, input.agent),
    "tasks.addAgent": (input) =>
      services.tasks.addToTeam(input.id, input.agent, input.lead === undefined ? {} : { lead: input.lead }),
    "tasks.removeAgent": (input) => services.tasks.removeFromTeam(input.id, input.agent),
    "team.swap": (input) => services.tasks.swapInTeam(input.task, input.agent, input.with),
    "team.set": (input) => services.tasks.setOverride(input),

    "room.send": async (input) => {
      services.tasks.get(input.task);
      // Secrets are saved and swapped for references before the text reaches an agent or the room.
      const captured = await services.secretService.capture(input.text);
      const item = await services.tasks.send({ ...input, text: captured.text });
      noteSecrets(services, input.task, captured.saved);
      return { item };
    },
    "room.cancel": async (input) => ({ cancelled: await services.tasks.cancel(input.task, input.agent) }),
    "room.permission": async (input) => ({
      item: services.tasks.answerPermission(input.task, input.item, input.option),
    }),
    "room.items": async (input) => services.tasks.items(input.task, input.limit, input.beforeSeq),
    "room.files": (input) => services.tasks.searchFiles(input.task, input.query),
    // Phase 2b commands, filled in by the 2b work. Each answers 501 until then.
    "tasks.link": (input) => services.tasks.link(input),
    "tasks.unlink": (input) => services.tasks.unlink(input),
    "room.fresh": async (input) => ({ item: await services.tasks.fresh(input.task, input.agent) }),
    "room.approve": async (input) => ({
      item: await services.admin.decide(input.task, input.item, input.decision),
    }),
    "room.secret": async (input) => ({
      item: await services.admin.answerSecret(input.task, input.item, input.value),
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
      const patch = {
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.limits === undefined ? {} : { limits: input.limits }),
        ...(input.resume === undefined ? {} : { resume: input.resume }),
        ...(input.rooms === undefined ? {} : { rooms: input.rooms }),
      };
      await config.setSettings(patch, {
        command: ctx.command,
        meta: ctx.meta,
        summary: `changed ${describePatch(patch)}`,
      });
      // Limits apply live: starts waiting in line may fit now.
      if (patch.limits !== undefined) await services.runs.limitsChanged();
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
    "boss.chat": (input) =>
      openBossChat({ config, store: services.store, tasks: services.tasks }, input.fresh === true),
    "health.run": () => (health ? health.run() : notBuilt()),
    "health.fix": (input) => (health ? health.fix(input.id) : notBuilt()),
    "system.version": () => (system ? system.version() : notBuilt()),
    "system.update": (input) => (system ? system.update(input.when) : notBuilt()),
    "decisions.ask": (input) => services.decisions.ask(input),
    "decisions.recent": async (input) => services.decisions.recent(input.limit),
    "decisions.status": () => services.decisions.status(),
    "decisions.set": (input, ctx) => services.decisions.set(input, ctx.meta, ctx.command),
    "decisions.install": () => services.decisions.install(),
    "usage.summary": async (input) => services.usage.summary(input.filters, input.tz),
    "usage.breakdown": async (input) => services.usage.breakdown(input),
    "usage.turns": async (input) => services.usage.turns(input.filters, input.limit),
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
async function requireConfigFile(config: ConfigService): Promise<void> {
  if (!(await config.sections()).exists) throw new UserError("Pick workspace roots first.", 409);
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

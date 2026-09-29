import type { CommandMeta, CommandName, CommandOutput, commands, Remount } from "@majhi/shared";
import { RESTART_COMMAND } from "@majhi/shared";
import type { z } from "zod";
import type { ConfigService } from "../config/service.ts";
import { UserError } from "../errors.ts";
import { isDirectory } from "../fs.ts";
import { HostJobError, type HostLink, HostOfflineError } from "../host/link.ts";
import type { RepoScanner } from "../scan/scanner.ts";
import type { Services } from "../services.ts";
import type { SshHostProbe } from "../ssh/hosts.ts";

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
}

export function createHandlers({
  config,
  scanner,
  hostLink,
  services,
  sshHosts,
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
    "agents.duplicate": (input, ctx) => agents.duplicate(input.id, input.newId, ctx.command, ctx.meta),
    "agents.remove": async (input, ctx) => {
      await agents.remove(input.id, ctx.command, ctx.meta);
      return { removed: input.id };
    },
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
    "tasks.create": (input) => services.tasks.create(input),
    "tasks.start": (input) => services.tasks.start(input.id),
    "tasks.stop": (input) => services.tasks.stop(input.id),
    "tasks.close": (input) => services.tasks.close(input.id),
    "tasks.remove": async (input) => {
      await services.tasks.remove(input.id, input.force === true);
      return { removed: input.id };
    },

    "room.send": async (input) => ({ item: await services.tasks.send(input) }),
    "room.cancel": async (input) => ({ cancelled: await services.tasks.cancel(input.task, input.agent) }),
    "room.permission": async (input) => ({
      item: services.tasks.answerPermission(input.task, input.item, input.option),
    }),
    "room.items": async (input) => services.tasks.items(input.task, input.limit, input.beforeSeq),
    "room.files": (input) => services.tasks.searchFiles(input.task, input.query),
    // Phase 2b commands, filled in by the 2b work. Each answers 501 until then.
    "tasks.link": notBuilt,
    "tasks.unlink": notBuilt,
    "room.fresh": notBuilt,
    "room.approve": notBuilt,
    "room.secret": notBuilt,
    "secrets.list": notBuilt,
    "secrets.save": notBuilt,
    "secrets.remove": notBuilt,
    "history.list": notBuilt,
    "history.undo": notBuilt,
    "settings.get": notBuilt,
    "settings.set": notBuilt,
    "policy.set": notBuilt,
    "boss.chat": notBuilt,
    "health.run": notBuilt,
    "health.fix": notBuilt,
    "system.version": notBuilt,
    "system.update": notBuilt,
  };
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
async function requestRemount(hostLink: HostLink, unmounted: readonly string[]): Promise<Remount> {
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

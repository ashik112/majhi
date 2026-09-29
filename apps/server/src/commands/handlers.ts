import type { CommandMeta, CommandName, CommandOutput, commands, Remount } from "@majhi/shared";
import { RESTART_COMMAND } from "@majhi/shared";
import type { z } from "zod";
import type { ConfigService } from "../config/service.ts";
import { isDirectory } from "../fs.ts";
import { HostJobError, type HostLink, HostOfflineError } from "../host/link.ts";
import type { RepoScanner } from "../scan/scanner.ts";
import type { Services } from "../services.ts";

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
}

export function createHandlers({ config, scanner, hostLink, services }: HandlerDeps): CommandHandlers {
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

    "host.status": async () => hostLink.status(),

    "fs.listDirs": (input) =>
      hostLink.call("listDirs", {
        path: input.path ?? config.paths.hostHome,
        showHidden: input.showHidden ?? false,
      }),

    "fs.suggestRoots": () => hostLink.call("suggestRoots", {}),

    "tools.list": async () => services.runtime.toolInfos(),

    "orgs.list": () => orgs.list(),
    "orgs.create": (input, ctx) => orgs.create(input, ctx.command, ctx.meta),

    "accounts.list": () => accounts.list(),
    "accounts.suggestId": async (input) => ({ id: await accounts.suggestId(input.tool, input.org) }),
    "accounts.create": (input, ctx) => accounts.create(input, ctx.command, ctx.meta),
    "accounts.remove": async (input, ctx) => {
      await accounts.remove(input.id, ctx.command, ctx.meta);
      return { removed: input.id };
    },
    "accounts.login.start": (input) => services.startLogin(input.id),
    "accounts.health": (input) => accounts.health(input.id),
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
  };
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

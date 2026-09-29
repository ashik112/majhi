import type { CommandMeta, CommandName, CommandOutput, commands } from "@majhi/shared";
import { RESTART_COMMAND } from "@majhi/shared";
import type { z } from "zod";
import type { ConfigService } from "../config/service.ts";
import { isDirectory } from "../fs.ts";
import type { RepoScanner } from "../scan/scanner.ts";

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
}

export function createHandlers({ config, scanner }: HandlerDeps): CommandHandlers {
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
      const roots = loaded.state.status === "loaded" ? loaded.state.config.workspaces : [];
      const visible = await Promise.all(roots.map((root) => isDirectory(root)));
      return {
        state: loaded.state,
        unmounted: roots.filter((_, i) => !visible[i]),
        restartCommand: RESTART_COMMAND,
      };
    },
  };
}

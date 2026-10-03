import type { CommandHandlers } from "../commands/handlers.ts";
import type { McpService } from "./service.ts";

type McpCommand = "mcp.search" | "mcp.install" | "mcp.enable" | "mcp.disable";

/** The `mcp.*` commands. The command table spreads these in. */
export function mcpHandlers(mcp: McpService): Pick<CommandHandlers, McpCommand> {
  return {
    "mcp.search": (input) => mcp.search(input.query, input.limit),
    "mcp.install": (input, ctx) => mcp.install(input, ctx.meta),
    "mcp.enable": (input, ctx) => mcp.enable(input, ctx.command, ctx.meta),
    "mcp.disable": (input, ctx) => mcp.disable(input, ctx.command, ctx.meta),
  };
}

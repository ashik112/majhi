import type { ToolId, ToolInfo } from "@majhi/shared";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import type { ToolDef } from "./types.ts";

export type { AuthStatus, ToolDef } from "./types.ts";

export const tools: Record<ToolId, ToolDef> = { claude, codex };

export function getTool(id: ToolId): ToolDef {
  return tools[id];
}

export function toolInfos(): ToolInfo[] {
  return Object.values(tools).map((t) => t.info);
}

import type { ToolId, ToolInfo } from "@majhi/shared";
import type { ToolSpec } from "../index.ts";

export const tools: Record<ToolId, ToolSpec> = {} as Record<ToolId, ToolSpec>;

export function getTool(id: ToolId): ToolSpec {
  return tools[id];
}

export function toolInfos(): ToolInfo[] {
  return Object.values(tools).map((t) => t.info);
}

import {
  type ConnectionConfig,
  type ConnectionTestResult,
  type ToolGate,
  textValue,
  words,
} from "@majhi/shared";
import { classifyTool } from "./gate.ts";

/**
 * What the gate does for each tool an MCP server listed in its last Test, read from the same
 * `classifyTool` a run uses, so the page never says something the gate will not do.
 */
export function toolGateOf(
  id: string,
  connection: ConnectionConfig,
  test: ConnectionTestResult | undefined,
): ToolGate[] {
  if ((connection.type !== "mcp" && connection.type !== "browser") || test?.tools === undefined) return [];
  const held = [
    {
      id,
      type: connection.type,
      server: id,
      allow: connection.allow ?? [],
      readTools: words(textValue(connection, "read_tools")),
      writeTools: words(textValue(connection, "write_tools")),
      toolAnnotations: test.toolAnnotations,
    },
  ];
  return test.tools.map((tool): ToolGate => {
    const verdict = classifyTool(id, tool, held);
    if (verdict.kind === "read") return { tool, gate: "read" };
    if (verdict.kind !== "write") return { tool, gate: "ask" };
    const write = verdict.writes[0];
    if (write === undefined) return { tool, gate: "ask" };
    return {
      tool,
      gate: write.destructive ? "destructive" : write.allowed ? "allowed" : "ask",
      why: write.why,
    };
  });
}

import type { McpServerSpec, StdioServerSpec } from "./session.ts";

/** Variable names of the values moved off the command line. Reserved: majhi's own, nothing else uses them. */
const PREFIX = "MAJHI_MCP_";

/**
 * Some agent CLIs get their MCP servers on their own command line: the Claude adapter starts
 * `claude --mcp-config '<json>'`, and the JSON holds every header and every server variable. Any
 * process of the same container could then read a bearer token from `ps` or `/proc/*\/cmdline`.
 * This swaps each header value and each stdio variable for `${NAME}`, which the CLI expands from its
 * own environment, and returns the values to put in the adapter's environment instead. The
 * environment of one process is not on any command line, and the run is one task's own container.
 * Empty values stay as they are: there is nothing to hide.
 */
export function mcpValuesToEnv(servers: readonly (McpServerSpec | StdioServerSpec)[]): {
  servers: (McpServerSpec | StdioServerSpec)[];
  env: Record<string, string>;
} {
  const env: Record<string, string> = {};
  const hide = (server: number, kind: "H" | "E", entry: number, value: string): string => {
    if (value === "") return value;
    const name = `${PREFIX}${server}_${kind}${entry}`;
    env[name] = value;
    return `\${${name}}`;
  };
  const swapped = servers.map((s, i): McpServerSpec | StdioServerSpec => {
    if (s.type === "stdio") {
      return {
        ...s,
        env: Object.fromEntries(Object.entries(s.env).map(([k, v], j) => [k, hide(i, "E", j, v)])),
      };
    }
    return {
      ...s,
      headers: Object.fromEntries(Object.entries(s.headers).map(([k, v], j) => [k, hide(i, "H", j, v)])),
    };
  });
  return { servers: swapped, env };
}

#!/usr/bin/env node
// A stand-in for a stdio MCP server, so tests never download one. It answers initialize and
// tools/list like any server. `FAKE_MCP_REQUIRE` names a variable it must have been started with.
import { createInterface } from "node:readline";

const need = process.env.FAKE_MCP_REQUIRE;
if (need !== undefined && !process.env[need]) {
  process.stderr.write(`fake mcp: ${need} is not set\n`);
  process.exit(1);
}
for (const name of Object.keys(process.env)) {
  if (/^MAJHI_/.test(name)) {
    process.stderr.write(`fake mcp: majhi's environment leaked ${name}\n`);
    process.exit(1);
  }
}
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-weather", version: "1.2.0" },
    });
  } else if (msg.method === "tools/list") {
    reply(msg.id, {
      tools: ["get_forecast", "list_stations", "set_alert"].map((name) => ({
        name,
        inputSchema: { type: "object" },
      })),
    });
  }
});

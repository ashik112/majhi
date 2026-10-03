import { z } from "zod";
import { ConnectionTestResultSchema, ConnectionViewSchema } from "./connections.ts";
import { IdSchema } from "./ids.ts";

/**
 * MCP servers (SPEC 5.2, Phase 6): installing one creates an `mcp` connection in an org (Phase 10),
 * so there is no second store. A server comes from the official MCP Registry, a remote URL, a local
 * command or a pasted `mcpServers` snippet. Installing is two steps, like skills: the first call
 * returns a preview and writes nothing, the second, with the preview's id, creates the connection
 * and runs Test. Secrets never pass through these commands: a secret entry is created empty and set
 * with `connections.setSecret` (the page's secure input, or a secret request).
 */

/** How a server was found. */
export const McpSourceKindSchema = z.enum(["registry", "url", "command", "json"]);
export type McpSourceKind = z.infer<typeof McpSourceKindSchema>;

export const McpSearchResultSchema = z.object({
  /** The registry name, like `io.github.acme/weather`. */
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  version: z.string(),
  /** The registry namespace that published it, like `io.github.acme`. */
  publisher: z.string(),
  /** The source repo to review before installing. */
  repository: z.string().optional(),
  websiteUrl: z.string().optional(),
  /** `streamable-http` or `sse` remotes, and `stdio` packages. */
  transports: z.array(z.string()),
  /** The package kinds it ships as, like npm, pypi, oci. */
  packages: z.array(z.string()),
  /** Pass to `mcp.install` as `registry`. */
  install: z.object({ registry: z.string() }),
});
export type McpSearchResult = z.infer<typeof McpSearchResultSchema>;

/** One header or environment entry of the server, as the preview shows it. */
export const McpEntryPreviewSchema = z.object({
  name: z.string(),
  kind: z.enum(["secret", "text"]),
  required: z.boolean(),
  description: z.string().optional(),
  /** A text value. A secret is never filled in here: it is set after installing. */
  value: z.string().optional(),
});
export type McpEntryPreview = z.infer<typeof McpEntryPreviewSchema>;

/** A text value the server needs that the owner gives with `values`: a URL variable, an argument, a header or variable. */
export const McpInputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean(),
  value: z.string().optional(),
  choices: z.array(z.string()).optional(),
});
export type McpInput = z.infer<typeof McpInputSchema>;

export const McpPreviewSchema = z.object({
  status: z.literal("preview"),
  /** Pass it as `confirm` to install what is shown. Valid for 30 minutes, once. */
  previewId: z.string(),
  org: IdSchema,
  /** The connection id it will get. */
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  source: z.object({
    kind: McpSourceKindSchema,
    registry: z.object({ name: z.string(), version: z.string() }).optional(),
    publisher: z.string().optional(),
    repository: z.string().optional(),
    websiteUrl: z.string().optional(),
    /** The package a local server runs, pinned. */
    package: z.object({ registryType: z.string(), identifier: z.string(), version: z.string() }).optional(),
  }),
  transport: z.enum(["remote", "local"]),
  /** Remote servers: Streamable HTTP or SSE. */
  protocol: z.enum(["http", "sse"]).optional(),
  url: z.string().optional(),
  /** Local servers: the command line majhi will start. */
  command: z.string().optional(),
  headers: z.array(McpEntryPreviewSchema),
  env: z.array(McpEntryPreviewSchema),
  /** Text values still to give. Confirming is refused while a required one is empty. */
  inputs: z.array(McpInputSchema),
  /** What the owner should weigh: an unpinned package, a value majhi did not keep. */
  warnings: z.array(z.string()),
  expiresAt: z.string(),
});
export type McpPreview = z.infer<typeof McpPreviewSchema>;

/** A secret entry of an installed server that is not set yet. */
export const McpNeedSchema = z.object({
  list: z.enum(["headers", "env"]),
  name: z.string(),
  required: z.boolean(),
  description: z.string().optional(),
});
export type McpNeed = z.infer<typeof McpNeedSchema>;

export const McpInstallResultSchema = z.discriminatedUnion("status", [
  McpPreviewSchema,
  z.object({
    status: z.literal("installed"),
    connection: ConnectionViewSchema,
    /** Secrets to set with connections.setSecret before the server works. */
    needs: z.array(McpNeedSchema),
    /** Test ran right after installing, with the tool list. Absent while a secret is missing. */
    test: ConnectionTestResultSchema.optional(),
  }),
]);
export type McpInstallResult = z.infer<typeof McpInstallResultSchema>;

const EntryNameSchema = z.string().trim().min(1).max(128);
const EntryValuesSchema = z.record(EntryNameSchema, z.string().max(4000));

/** `mcp.install`: what to install, then, to commit, the preview's id. */
export const McpInstallInputSchema = z
  .object({
    /** A registry name, like `io.github.acme/weather`. */
    registry: z.string().trim().min(3).max(300).optional(),
    /** The registry version. Default: the latest. */
    version: z.string().trim().min(1).max(100).optional(),
    /** Registry servers that ship a remote and a package: which to use. Default: the remote. */
    via: z.enum(["remote", "package"]).optional(),
    /** A remote server's address (Streamable HTTP or SSE). */
    url: z.string().trim().min(1).max(2048).optional(),
    protocol: z.enum(["http", "sse"]).optional(),
    /** A local command, like `npx -y @acme/mcp-weather@1.2.0`. */
    command: z.string().trim().min(1).max(2000).optional(),
    /** A pasted `mcpServers` or `.mcp.json` snippet. */
    json: z.string().trim().min(2).max(20000).optional(),
    /** The server of a snippet that holds several. */
    pick: z.string().trim().min(1).max(200).optional(),
    /** Headers of a URL server by name. A name that reads like a secret is made a secret entry and its value is not kept. */
    headers: EntryValuesSchema.optional(),
    /** Variables of a local command by name, the same way. */
    env: EntryValuesSchema.optional(),
    /** Names of headers or variables to treat as secrets. */
    secrets: z.array(EntryNameSchema).max(50).optional(),
    /** Text values the registry's server needs, by the name the preview lists under `inputs`. */
    values: EntryValuesSchema.optional(),
    /** The org that gets the connection. Default: the only org there is. */
    org: IdSchema.optional(),
    id: IdSchema.optional(),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(2000).optional(),
    /** The id from the preview. Installs exactly what the preview showed. */
    confirm: z.string().trim().min(1).max(100).optional(),
    /** With `confirm`: also turn the server on for this one agent, which must belong to the connection's org. */
    enable: IdSchema.optional(),
  })
  .refine(
    (v) =>
      v.confirm !== undefined ||
      [v.registry, v.url, v.command, v.json].filter((x) => x !== undefined).length === 1,
    { message: "Give one of registry, url, command or json, or the confirm id of a preview" },
  )
  .refine((v) => v.enable === undefined || v.confirm !== undefined, {
    message: "enable goes with the confirm id of a preview",
  });
export type McpInstallInput = z.infer<typeof McpInstallInputSchema>;

/** `mcp.enable` and `mcp.disable`: an MCP server for one agent. */
export const McpAgentInputSchema = z.object({ connection: IdSchema, agent: IdSchema });
export type McpAgentInput = z.infer<typeof McpAgentInputSchema>;

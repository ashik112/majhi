import { z } from "zod";
import {
  ConfigStateSchema,
  RemountSchema,
  ReposResponseSchema,
  WorkspacesUpdateResultSchema,
  WorkspacesUpdateSchema,
} from "./api.ts";
import { DirListingSchema, HostResultSchemas, HostStatusSchema } from "./host.ts";

/**
 * Every change in majhi is a command (SPEC 5.16). The UI, the palette, the
 * boss agent and tests all call commands through the same endpoint:
 * `POST /api/cmd/<name>` with the input as JSON, answered with the output.
 */
export const RiskClassSchema = z.enum(["read", "change", "destructive", "outbound"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("agent"), id: z.string().min(1) }),
]);
export type Actor = z.infer<typeof ActorSchema>;

export interface CommandDef<I extends z.ZodType, O extends z.ZodType> {
  risk: RiskClass;
  summary: string;
  input: I;
  output: O;
}

const Empty = z.object({});

export const commands = {
  "config.get": {
    risk: "read",
    summary: "Show the loaded config, or why it failed to load",
    input: Empty,
    output: ConfigStateSchema,
  },
  "repos.scan": {
    risk: "read",
    summary: "List the git repos found under every workspace root",
    input: z.object({ refresh: z.boolean().optional() }),
    output: ReposResponseSchema,
  },
  "workspaces.set": {
    risk: "change",
    summary: "Set the workspace roots and the tasks folder",
    input: WorkspacesUpdateSchema,
    output: WorkspacesUpdateResultSchema,
  },
  "workspaces.remount": {
    risk: "change",
    summary: "Mount every root in majhi.yaml by restarting majhi through the host helper",
    input: Empty,
    output: z.object({ remount: RemountSchema, unmounted: z.array(z.string()) }),
  },
  "host.status": {
    risk: "read",
    summary: "Show whether the host helper is connected",
    input: Empty,
    output: HostStatusSchema,
  },
  "fs.listDirs": {
    risk: "read",
    summary: "List the subfolders of a folder on the host (default: home)",
    input: z.object({ path: z.string().optional(), showHidden: z.boolean().optional() }),
    output: DirListingSchema,
  },
  "fs.suggestRoots": {
    risk: "read",
    summary: "Suggest workspace roots: folders under home that hold git repos",
    input: Empty,
    output: HostResultSchemas.suggestRoots,
  },
} as const satisfies Record<string, CommandDef<z.ZodType, z.ZodType>>;

export type CommandName = keyof typeof commands;
export type CommandInput<N extends CommandName> = z.input<(typeof commands)[N]["input"]>;
export type CommandOutput<N extends CommandName> = z.infer<(typeof commands)[N]["output"]>;

/** Optional metadata sent with a command, recorded in the config history. */
export const CommandMetaSchema = z.object({
  actor: ActorSchema.default({ kind: "owner" }),
  reason: z.string().max(500).optional(),
});
export type CommandMeta = z.infer<typeof CommandMetaSchema>;

/** Header carrying the JSON-encoded CommandMeta on `POST /api/cmd/<name>`. */
export const COMMAND_META_HEADER = "x-majhi-meta";

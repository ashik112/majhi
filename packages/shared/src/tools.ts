import { z } from "zod";
import { IdSchema } from "./ids.ts";

/**
 * Command-line tools a workspace installs for its agents and scripts: release binaries in the
 * workspace's tools folder, `<majhi home>/tools/<org>/bin`. Runs, watch scripts and the captain's
 * secret fetches find them on PATH. majhi downloads and checks each one itself, so an agent never
 * has to fetch and trust a binary inside its sandbox.
 */

export const TOOL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ToolNameSchema = z
  .string()
  .trim()
  .regex(TOOL_NAME, "A tool name is lowercase letters, digits, dots, hyphens and underscores, at most 64");

/** How the download holds the program. */
export const TOOL_ARCHIVES = ["binary", "tar.gz", "zip"] as const;
export const ToolArchiveSchema = z.enum(TOOL_ARCHIVES);

const Sha256Schema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/, "A SHA-256 is 64 hex characters");

export const ToolInstallInputSchema = z
  .object({
    /** The workspace. An agent works in its own. */
    org: IdSchema.optional(),
    /** The program's name on PATH: `doctl`, `kubectl`. */
    name: ToolNameSchema,
    /**
     * The vendor's release download, https. `{arch}` becomes amd64 or arm64 and `{machine}` becomes
     * x86_64 or aarch64, to match the runner image's CPU. `tools.list` says which one it is.
     */
    url: z.string().trim().url().max(1000),
    /** The vendor's published SHA-256 of that download. Give this or `checksumUrl`. */
    sha256: Sha256Schema.optional(),
    /** The vendor's checksums file (one hash, or `<hash>  <file name>` lines), https. */
    checksumUrl: z.string().trim().url().max(1000).optional(),
    archive: ToolArchiveSchema.default("binary"),
    /** The program's path inside the archive. Defaults to the tool's name. */
    path: z.string().trim().min(1).max(300).optional(),
  })
  .refine((v) => v.sha256 !== undefined || v.checksumUrl !== undefined, {
    message: "Give the vendor's sha256, or checksumUrl: majhi installs nothing it cannot verify.",
    path: ["sha256"],
  });
export type ToolInstallInput = z.infer<typeof ToolInstallInputSchema>;

export const InstalledToolSchema = z.object({
  name: ToolNameSchema,
  url: z.string(),
  /** The SHA-256 of the download that matched. */
  sha256: z.string(),
  /** Where the checksum came from. */
  verifiedBy: z.enum(["given", "checksum-file"]),
  /** Size of the installed program in bytes. */
  bytes: z.number().int().nonnegative(),
  installedAt: z.string(),
});
export type InstalledTool = z.infer<typeof InstalledToolSchema>;

export const ToolsListInputSchema = z.object({ org: IdSchema.optional() });
export const ToolsListSchema = z.object({
  org: IdSchema,
  /** The CPU the runner image runs on: pick the matching download. */
  arch: z.object({ arch: z.enum(["amd64", "arm64"]), machine: z.enum(["x86_64", "aarch64"]) }),
  tools: z.array(InstalledToolSchema),
});
export type ToolsList = z.infer<typeof ToolsListSchema>;

export const ToolRemoveInputSchema = z.object({ org: IdSchema.optional(), name: ToolNameSchema });

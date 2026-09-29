import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "@majhi/shared";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { formatIssues } from "./errors.ts";

/** `apps/web/dist`, found from `apps/server/src` (tsx) and `apps/server/dist` (bundle) alike. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

const AbsolutePath = z
  .string()
  .trim()
  .min(1)
  .refine((p) => p.startsWith("/"), { message: "Use an absolute path" });

const EnvSchema = z.object({
  MAJHI_HOST: z.string().trim().min(1).default("127.0.0.1"),
  MAJHI_PORT: z.coerce.number().int().min(1).max(65535).default(7070),
  HOST_HOME: AbsolutePath.optional(),
  MAJHI_HOME: z.string().trim().min(1).optional(),
  MAJHI_WEB_DIST: AbsolutePath.optional(),
  MAJHI_VERSION: z.string().trim().min(1).optional(),
});

export interface ServerEnv {
  host: string;
  port: number;
  /** The owner's home on the host. `~` in majhi.yaml expands against it. */
  hostHome: string;
  /** The config folder holding majhi.yaml. */
  majhiHome: string;
  webDist: string;
  version: string;
}

/** Reads the server settings from environment variables. Throws with one line per bad variable. */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = EnvSchema.safeParse(emptyToUndefined(source));
  if (!result.success) {
    throw new Error(`Invalid environment:\n${formatIssues(result.error).join("\n")}`);
  }
  const env = result.data;
  const hostHome = resolve(env.HOST_HOME ?? homedir());
  const majhiHome = expandHome(env.MAJHI_HOME ?? `${hostHome}/.majhi`, hostHome);
  if (!majhiHome.startsWith("/")) {
    throw new Error("Invalid environment:\nMAJHI_HOME: Use an absolute path, or one starting with ~/");
  }
  return {
    host: env.MAJHI_HOST,
    port: env.MAJHI_PORT,
    hostHome,
    majhiHome: resolve(majhiHome),
    webDist: env.MAJHI_WEB_DIST ?? DEFAULT_WEB_DIST,
    version: env.MAJHI_VERSION ?? pkg.version,
  };
}

/** Compose passes unset variables from `.env` as empty strings. Treat them as unset. */
function emptyToUndefined(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const value = source[key];
    out[key] = value === undefined || value.trim() === "" ? undefined : value;
  }
  return out;
}

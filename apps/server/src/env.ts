import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeOptions } from "@majhi/acp";
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

/** A command as a JSON array, `["node","/path/fake-adapter.js"]`, for MAJHI_ADAPTER_CLAUDE and MAJHI_ADAPTER_CODEX. */
const JsonCommand = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: 'Use a JSON array like ["command","arg"]' });
      return z.NEVER;
    }
  })
  .pipe(z.tuple([z.string().min(1)], z.string()))
  .transform(([command, ...args]) => ({ command, args }));

const EnvSchema = z.object({
  MAJHI_HOST: z.string().trim().min(1).default("127.0.0.1"),
  MAJHI_PORT: z.coerce.number().int().min(1).max(65535).default(7070),
  HOST_HOME: AbsolutePath.optional(),
  MAJHI_HOME: z.string().trim().min(1).optional(),
  MAJHI_WEB_DIST: AbsolutePath.optional(),
  MAJHI_VERSION: z.string().trim().min(1).optional(),
  MAJHI_SECRETS_KEY_FILE: AbsolutePath.default("/run/secrets/majhi_key"),
  MAJHI_ADAPTER_CLAUDE: JsonCommand.optional(),
  MAJHI_ADAPTER_CODEX: JsonCommand.optional(),
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
  /** File holding the age identity that protects `secrets.age`. It may not exist. */
  secretsKeyFile: string;
  /** How agent CLIs are started: the only host values they see, and adapter overrides for tests. */
  runtime: RuntimeOptions;
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
  const adapters: NonNullable<RuntimeOptions["adapters"]> = {};
  if (env.MAJHI_ADAPTER_CLAUDE !== undefined) adapters.claude = env.MAJHI_ADAPTER_CLAUDE;
  if (env.MAJHI_ADAPTER_CODEX !== undefined) adapters.codex = env.MAJHI_ADAPTER_CODEX;
  return {
    host: env.MAJHI_HOST,
    port: env.MAJHI_PORT,
    hostHome,
    majhiHome: resolve(majhiHome),
    webDist: env.MAJHI_WEB_DIST ?? DEFAULT_WEB_DIST,
    version: env.MAJHI_VERSION ?? pkg.version,
    secretsKeyFile: env.MAJHI_SECRETS_KEY_FILE,
    runtime: { base: baseEnv(source), adapters },
  };
}

/** PATH, TMPDIR, LANG and SSH_AUTH_SOCK from the server's environment, and nothing else. */
export function baseEnv(source: NodeJS.ProcessEnv): RuntimeOptions["base"] {
  const base: RuntimeOptions["base"] = { PATH: source.PATH || "/usr/local/bin:/usr/bin:/bin" };
  if (source.TMPDIR) base.TMPDIR = source.TMPDIR;
  if (source.LANG) base.LANG = source.LANG;
  if (source.SSH_AUTH_SOCK) base.SSH_AUTH_SOCK = source.SSH_AUTH_SOCK;
  return base;
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

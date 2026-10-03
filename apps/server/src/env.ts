import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeOptions } from "@majhi/acp";
import { DEFAULT_MAJHI_ORIGIN, expandHome } from "@majhi/shared";
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
  /** Git commit the image was built from, baked in by the Dockerfile. */
  MAJHI_COMMIT: z.string().trim().min(1).optional(),
  MAJHI_SECRETS_KEY_FILE: AbsolutePath.default("/run/secrets/majhi_key"),
  /** The SSH agent socket gen-override gave the server, or `off` (DECISIONS). Only `off` is read here. */
  MAJHI_SSH_AGENT: z.string().trim().min(1).optional(),
  MAJHI_ADAPTER_CLAUDE: JsonCommand.optional(),
  MAJHI_ADAPTER_CODEX: JsonCommand.optional(),
  /** Replaces the Claude usage helper, for tests. */
  MAJHI_USAGE_CLAUDE: JsonCommand.optional(),
  /** Offline detection: `http` (default), `off`, or `file:<path>` (offline while the file exists, for tests). */
  MAJHI_NET_PROBE: z
    .string()
    .trim()
    .regex(/^(http|off|file:\/.+)$/, "Use http, off, or file:/absolute/path")
    .optional(),
  /** How often the network probe runs, in ms. Default 20000. */
  MAJHI_NET_PROBE_MS: z.coerce.number().int().min(100).optional(),
  /** Laya in Docker (laya-serve), for machines without the native one. */
  MAJHI_LAYA_URL: z.url().optional(),
  /** Its container, which majhi starts on the first question and stops when idle. */
  MAJHI_LAYA_CONTAINER: z.string().trim().min(1).optional(),
  /**
   * Where agent sessions run: `container` (a runner container per run, the default) or `local` (next
   * to majhi, with majhi's own file access: only for tests and development, and only when set).
   */
  MAJHI_RUNNER: z.enum(["local", "container"]).default("container"),
  MAJHI_RUNNER_IMAGE: z.string().trim().min(1).default("majhi-runner:dev"),
  MAJHI_RUNNER_NETWORK: z.string().trim().min(1).default("majhi-runners"),
  /** `uid:gid` agents run as, the owner's. */
  MAJHI_RUNNER_USER: z
    .string()
    .trim()
    .regex(/^\d+:\d+$/, "Use uid:gid, like 501:20")
    .optional(),
  /** The name runners reach majhi at on their network. */
  MAJHI_RUNNER_MCP_HOST: z.string().trim().min(1).default("majhi-server"),
  /**
   * majhi's address as the owner's browser reaches it, for OAuth callbacks. Compose passes
   * `http://127.0.0.1:${MAJHI_PORT}`, the host-side port, which the server itself cannot see.
   */
  MAJHI_ORIGIN: z.url({ protocol: /^https?$/, error: "Use an http:// URL" }).optional(),
  /** Memory cap per run. */
  MAJHI_RUNNER_MEMORY: z
    .string()
    .trim()
    .regex(/^\d+[kmg]$/, "Use a size like 4g")
    .default("4g"),
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
  /** Git commit the running image was built from, or `dev` when unknown. */
  commit: string;
  /** File holding the age identity that protects `secrets.age`. It may not exist. */
  secretsKeyFile: string;
  /** `MAJHI_SSH_AGENT=off`: the owner turned off the SSH agent for majhi's git. */
  sshAgentOff: boolean;
  /** How agent CLIs are started: the only host values they see, and adapter overrides for tests. */
  runtime: RuntimeOptions;
  /** `MAJHI_NET_PROBE`: how majhi checks it is online. */
  netProbe?: string;
  /** `MAJHI_NET_PROBE_MS`. */
  netProbeMs?: number;
  /** Runner isolation (Phase 2c). */
  runner: RunnerEnv;
  /** Laya in Docker (Phase 3), when configured. */
  laya?: { url: string; container?: string };
  /** `MAJHI_ORIGIN` without a trailing slash: where the browser reaches majhi. */
  origin: string;
}

export interface RunnerEnv {
  mode: "local" | "container";
  image: string;
  network: string;
  user?: string;
  mcpHost: string;
  memory: string;
  /** The docker CLI. */
  docker: string;
  /** PATH and DOCKER_HOST for the docker CLI. Never passed to an agent. */
  cliEnv: Record<string, string>;
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
  const usage: NonNullable<RuntimeOptions["usage"]> = {};
  if (env.MAJHI_USAGE_CLAUDE !== undefined) usage.claude = env.MAJHI_USAGE_CLAUDE;
  return {
    host: env.MAJHI_HOST,
    port: env.MAJHI_PORT,
    hostHome,
    majhiHome: resolve(majhiHome),
    webDist: env.MAJHI_WEB_DIST ?? DEFAULT_WEB_DIST,
    version: env.MAJHI_VERSION ?? pkg.version,
    commit: env.MAJHI_COMMIT ?? "dev",
    secretsKeyFile: env.MAJHI_SECRETS_KEY_FILE,
    sshAgentOff: env.MAJHI_SSH_AGENT === "off",
    runtime: { base: baseEnv(source), adapters, usage },
    ...(env.MAJHI_NET_PROBE === undefined ? {} : { netProbe: env.MAJHI_NET_PROBE }),
    ...(env.MAJHI_NET_PROBE_MS === undefined ? {} : { netProbeMs: env.MAJHI_NET_PROBE_MS }),
    ...(env.MAJHI_LAYA_URL === undefined
      ? {}
      : {
          laya: {
            url: env.MAJHI_LAYA_URL,
            ...(env.MAJHI_LAYA_CONTAINER === undefined ? {} : { container: env.MAJHI_LAYA_CONTAINER }),
          },
        }),
    origin: (env.MAJHI_ORIGIN ?? DEFAULT_MAJHI_ORIGIN).replace(/\/+$/, ""),
    runner: {
      mode: env.MAJHI_RUNNER,
      image: env.MAJHI_RUNNER_IMAGE,
      network: env.MAJHI_RUNNER_NETWORK,
      ...(env.MAJHI_RUNNER_USER === undefined ? {} : { user: env.MAJHI_RUNNER_USER }),
      mcpHost: env.MAJHI_RUNNER_MCP_HOST,
      memory: env.MAJHI_RUNNER_MEMORY,
      docker: "docker",
      cliEnv: {
        PATH: source.PATH || "/usr/local/bin:/usr/bin:/bin",
        ...(source.DOCKER_HOST ? { DOCKER_HOST: source.DOCKER_HOST } : {}),
      },
    },
  };
}

/**
 * PATH, TMPDIR, LANG and PLAYWRIGHT_BROWSERS_PATH from the server's environment, and nothing else. SSH_AUTH_SOCK is
 * left out on purpose: only the server's own git uses it, never an agent run (SPEC 4.5).
 */
export function baseEnv(source: NodeJS.ProcessEnv): RuntimeOptions["base"] {
  const base: RuntimeOptions["base"] = { PATH: source.PATH || "/usr/local/bin:/usr/bin:/bin" };
  if (source.TMPDIR) base.TMPDIR = source.TMPDIR;
  if (source.LANG) base.LANG = source.LANG;
  if (source.PLAYWRIGHT_BROWSERS_PATH) base.PLAYWRIGHT_BROWSERS_PATH = source.PLAYWRIGHT_BROWSERS_PATH;
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

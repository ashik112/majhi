import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { expandHome } from "@majhi/shared";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

const EnvSchema = z.object({
  MAJHI_URL: z.url({ protocol: /^https?$/, error: "Use an http:// URL" }).default("http://127.0.0.1:7070"),
  MAJHI_HOME: z.string().trim().min(1).default("~/.majhi"),
  /** The majhi checkout that `docker compose` runs in. Without it, remounting is manual. */
  MAJHI_REPO: z.string().trim().min(1).optional(),
  MAJHI_HOST_VERSION: z.string().trim().min(1).optional(),
});

export interface HostConfig {
  /** majhi's server, without a trailing slash. */
  url: string;
  /** The owner's home. `~` in paths expands against it. */
  home: string;
  majhiHome: string;
  repo: string | undefined;
  version: string;
}

/** Reads the helper's settings from environment variables. Throws with one line per bad variable. */
export function parseHostConfig(source: NodeJS.ProcessEnv = process.env, home = homedir()): HostConfig {
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const value = source[key];
    // An empty variable, as a plist or `.env` may hold, counts as unset.
    raw[key] = value === undefined || value.trim() === "" ? undefined : value;
  }
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  const env = result.data;
  const majhiHome = expandHome(env.MAJHI_HOME, home);
  const repo = env.MAJHI_REPO === undefined ? undefined : expandHome(env.MAJHI_REPO, home);
  for (const [name, path] of [
    ["MAJHI_HOME", majhiHome],
    ["MAJHI_REPO", repo],
  ] as const) {
    if (path !== undefined && !isAbsolute(path)) {
      throw new Error(`Invalid environment:\n${name}: Use an absolute path, or one starting with ~/`);
    }
  }
  return {
    url: env.MAJHI_URL.replace(/\/+$/, ""),
    home,
    majhiHome: resolve(majhiHome),
    repo: repo === undefined ? undefined : resolve(repo),
    version: env.MAJHI_HOST_VERSION ?? pkg.version,
  };
}

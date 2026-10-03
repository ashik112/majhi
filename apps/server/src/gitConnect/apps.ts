import { readFile } from "node:fs/promises";
import {
  BUILT_IN_OAUTH_APPS,
  type CommandMeta,
  DEFAULT_GIT_HOST,
  type GitAppsConfig,
  GitAppsConfigSchema,
  type GitAppsSetInputSchema,
  type GitAppsView,
} from "@majhi/shared";
import { parseDocument } from "yaml";
import type { z } from "zod";
import type { ConfigService } from "../config/service.ts";
import { writeGitApps } from "../config/write.ts";
import { errorCode } from "../errors.ts";

/** The apps of majhi's own device-flow sign-in: this install's, else majhi's built-in public IDs. */
export interface EffectiveApps {
  github?: { clientId: string; builtIn: boolean };
  gitlab: Record<string, { clientId: string; builtIn: boolean }>;
}

/**
 * `git_apps` from majhi.yaml. Read on its own, so a problem elsewhere in the file does not hide it.
 * A missing file or a bad `git_apps` reads as empty: sign-in then uses the CLI or a pasted token.
 */
export async function readGitApps(file: string): Promise<GitAppsConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return {};
    throw err;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return {};
  const raw = (doc.toJS() as { git_apps?: unknown } | null)?.git_apps;
  const parsed = GitAppsConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export function effectiveApps(config: GitAppsConfig, builtIn = BUILT_IN_OAUTH_APPS): EffectiveApps {
  const gitlab: EffectiveApps["gitlab"] = {};
  for (const [host, id] of Object.entries(builtIn.gitlab)) {
    if (id !== "") gitlab[host] = { clientId: id, builtIn: true };
  }
  for (const [host, app] of Object.entries(config.gitlab ?? {}))
    gitlab[host] = { clientId: app.client_id, builtIn: false };
  const github =
    config.github !== undefined
      ? { clientId: config.github.client_id, builtIn: false }
      : builtIn.github !== ""
        ? { clientId: builtIn.github, builtIn: true }
        : undefined;
  return { gitlab, ...(github === undefined ? {} : { github }) };
}

export function appsView(apps: EffectiveApps): GitAppsView {
  return {
    github: apps.github === undefined ? {} : { clientId: apps.github.clientId, builtIn: apps.github.builtIn },
    gitlab: Object.entries(apps.gitlab)
      .map(([host, app]) => ({ host, clientId: app.clientId, builtIn: app.builtIn }))
      .sort((a, b) => a.host.localeCompare(b.host)),
  };
}

export interface AppsDeps {
  config: Pick<ConfigService, "file" | "change">;
}

/** Saves or removes one host's app: one config commit. */
export async function setApp(
  deps: AppsDeps,
  input: z.output<typeof GitAppsSetInputSchema>,
  change: { command: string; meta: CommandMeta },
): Promise<GitAppsConfig> {
  const current = await readGitApps(deps.config.file);
  const next: GitAppsConfig = { ...current };
  let summary: string;
  if (input.kind === "github") {
    if (input.clientId === null) delete next.github;
    else next.github = { client_id: input.clientId };
    summary = input.clientId === null ? "removed the GitHub app" : "set the GitHub app";
  } else {
    const gitlab = { ...(next.gitlab ?? {}) };
    if (input.clientId === null) delete gitlab[input.host];
    else gitlab[input.host] = { client_id: input.clientId };
    if (Object.keys(gitlab).length === 0) delete next.gitlab;
    else next.gitlab = gitlab;
    summary = `${input.clientId === null ? "removed" : "set"} the GitLab app for ${input.host}`;
  }
  await deps.config.change({ ...change, summary }, () => writeGitApps(deps.config.file, next));
  return next;
}

/** The client ID to sign in to `host` with, or undefined when the host has no app. */
export function clientIdFor(
  apps: EffectiveApps,
  kind: "github" | "gitlab",
  host: string,
): string | undefined {
  if (kind === "github") return host === DEFAULT_GIT_HOST.github ? apps.github?.clientId : undefined;
  return apps.gitlab[host]?.clientId;
}

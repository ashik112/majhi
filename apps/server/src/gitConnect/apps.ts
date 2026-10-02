import { readFile } from "node:fs/promises";
import {
  BUILT_IN_OAUTH_APPS,
  type CommandMeta,
  DEFAULT_GIT_HOST,
  type GitAppsConfig,
  GitAppsConfigSchema,
  type GitAppsSetInputSchema,
  type GitAppsView,
  oauthCallbackUrl,
} from "@majhi/shared";
import { parseDocument } from "yaml";
import type { z } from "zod";
import type { ConfigService } from "../config/service.ts";
import { writeGitApps } from "../config/write.ts";
import { errorCode, UserError } from "../errors.ts";

/** The label the Bitbucket consumer secret is saved under in `secrets.age`. */
export const BITBUCKET_SECRET_LABEL = "bitbucket oauth consumer";

/** The apps majhi signs in with: this install's, else majhi's built-in public IDs. */
export interface EffectiveApps {
  github?: { clientId: string; builtIn: boolean };
  gitlab: Record<string, { clientId: string; builtIn: boolean }>;
  bitbucket?: { key: string; secretRef: string };
}

/**
 * `git_apps` from majhi.yaml. Read on its own, so a problem elsewhere in the file does not hide it.
 * A missing file or a bad `git_apps` reads as empty: sign-in then answers needs-app.
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
  return {
    gitlab,
    ...(github === undefined ? {} : { github }),
    ...(config.bitbucket === undefined
      ? {}
      : { bitbucket: { key: config.bitbucket.key, secretRef: config.bitbucket.secret } }),
  };
}

export function appsView(apps: EffectiveApps, secretSaved: boolean, origin: string): GitAppsView {
  return {
    github: apps.github === undefined ? {} : { clientId: apps.github.clientId, builtIn: apps.github.builtIn },
    gitlab: Object.entries(apps.gitlab)
      .map(([host, app]) => ({ host, clientId: app.clientId, builtIn: app.builtIn }))
      .sort((a, b) => a.host.localeCompare(b.host)),
    bitbucket: { ...(apps.bitbucket === undefined ? {} : { key: apps.bitbucket.key }), secretSaved },
    origin,
    bitbucketCallback: oauthCallbackUrl(origin, "bitbucket"),
  };
}

export interface AppsDeps {
  config: Pick<ConfigService, "file" | "change">;
  secrets: {
    save(input: { value: string; label: string }): Promise<{ name: string; ref: string }>;
    set(name: string, value: string): Promise<void>;
    has(name: string): Promise<boolean>;
    delete(name: string): Promise<void>;
  };
}

const nameOf = (ref: string) => ref.replace(/^secret:/, "");

/**
 * Saves or removes one host's app. The Bitbucket secret goes to `secrets.age` (rewritten in place
 * when one is saved already) and only its reference to majhi.yaml. One config commit.
 */
export async function setApp(
  deps: AppsDeps,
  input: z.output<typeof GitAppsSetInputSchema>,
  change: { command: string; meta: CommandMeta },
): Promise<GitAppsConfig> {
  const current = await readGitApps(deps.config.file);
  const next: GitAppsConfig = { ...current };
  let dropSecret: string | undefined;
  let summary: string;
  if (input.kind === "github") {
    if (input.clientId === null) delete next.github;
    else next.github = { client_id: input.clientId };
    summary = input.clientId === null ? "removed the GitHub app" : "set the GitHub app";
  } else if (input.kind === "gitlab") {
    const gitlab = { ...(next.gitlab ?? {}) };
    if (input.clientId === null) delete gitlab[input.host];
    else gitlab[input.host] = { client_id: input.clientId };
    if (Object.keys(gitlab).length === 0) delete next.gitlab;
    else next.gitlab = gitlab;
    summary = `${input.clientId === null ? "removed" : "set"} the GitLab app for ${input.host}`;
  } else {
    if (input.consumer === null) {
      dropSecret = current.bitbucket?.secret;
      delete next.bitbucket;
      summary = "removed the Bitbucket consumer";
    } else {
      const existing = current.bitbucket?.secret;
      let ref: string;
      if (existing !== undefined && (await deps.secrets.has(nameOf(existing)).catch(() => false))) {
        await deps.secrets.set(nameOf(existing), input.consumer.secret);
        ref = existing;
      } else {
        ref = (await deps.secrets.save({ value: input.consumer.secret, label: BITBUCKET_SECRET_LABEL })).ref;
      }
      next.bitbucket = { key: input.consumer.key, secret: ref };
      summary = "set the Bitbucket consumer";
    }
  }
  await deps.config.change({ ...change, summary }, () => writeGitApps(deps.config.file, next));
  if (dropSecret !== undefined) await deps.secrets.delete(nameOf(dropSecret)).catch(() => undefined);
  return next;
}

/** The consumer key and secret for a Bitbucket exchange or refresh. Throws a plain sentence when missing. */
export async function bitbucketConsumer(
  apps: EffectiveApps,
  readSecret: (name: string) => Promise<string | undefined>,
): Promise<{ key: string; secret: string }> {
  const app = apps.bitbucket;
  if (app === undefined)
    throw new UserError("Bitbucket sign-in is not set up. Add majhi's consumer first.", 409);
  const secret = await readSecret(nameOf(app.secretRef)).catch(() => undefined);
  if (secret === undefined) {
    throw new UserError(
      "The Bitbucket consumer's secret is missing. Paste the consumer's Key and Secret again.",
      409,
    );
  }
  return { key: app.key, secret };
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

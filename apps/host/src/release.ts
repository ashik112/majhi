import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { UPLOAD_PACK } from "./gitGuard.ts";
import { readPackage, readPublishedPackage, replacePackage, writeRuntime } from "./releasePackage.ts";
import { type GitContext, guardedGit, type RepoState, readRepo } from "./repoInfo.ts";

/**
 * Release installs name their version and release endpoints in .env. New installs hold only
 * runtime setup files and release.json; older installs keep a tagged checkout. Development
 * checkouts have no MAJHI_VERSION and build the code on disk. Both release formats retain their
 * previous files and settings until the new images start successfully.
 */

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const VERSION_LINE = /^\s*MAJHI_VERSION\s*=/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const ENV_FILE = ".env";
/** How often a release install asks the pointer whether a newer release is out. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
const LATEST_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 60_000;
const CHECKOUT_TIMEOUT_MS = 120_000;

/** What the pointer answers: GitHub's release object, of which only the tag counts. */
const LatestSchema = z.object({ tag_name: z.string().regex(RELEASE_TAG) });

/** Reads the tag the latest-release pointer at `url` names. Throws with the reason when it cannot. */
export type LatestFn = (url: string) => Promise<string>;

export const readLatest: LatestFn = async (url) => {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "majhi-host" },
    signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const parsed = LatestSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new Error(`${url} names no majhi release`);
  return parsed.data.tag_name;
};

export interface Release {
  tag: string;
  commit: string;
}

/** What the checkout's `.env` says about its release. */
export interface InstalledRelease {
  version: string;
  /** Where the latest release is read. Without it the install stays on its release. */
  latestUrl: string | undefined;
  downloadUrl?: string | undefined;
}

/** The last value of `name` in a `.env` text, without quotes. Undefined when unset or empty. */
export function dotenvValue(
  dotenv: string,
  name: "MAJHI_VERSION" | "MAJHI_LATEST_URL" | "MAJHI_DOWNLOAD_URL",
): string | undefined {
  const pattern = new RegExp(`^\\s*${name}\\s*=(.*)$`);
  let found: string | undefined;
  for (const line of dotenv.split(/\r?\n/)) {
    const value = pattern.exec(line)?.[1];
    if (value !== undefined) found = value.trim().replace(/^["']|["']$/g, "");
  }
  return found === "" ? undefined : found;
}

/** The release a `.env` text names. Undefined on a dev checkout. */
export function releaseIn(dotenv: string): InstalledRelease | undefined {
  const version = dotenvValue(dotenv, "MAJHI_VERSION");
  return version === undefined
    ? undefined
    : {
        version,
        latestUrl: dotenvValue(dotenv, "MAJHI_LATEST_URL"),
        downloadUrl: dotenvValue(dotenv, "MAJHI_DOWNLOAD_URL"),
      };
}

/** The `.env` text with MAJHI_VERSION set to `version` on the last line, every other line kept. */
export function withVersion(dotenv: string, version: string): string {
  const kept = dotenv.split("\n").filter((line) => !VERSION_LINE.test(line));
  if (kept.at(-1) === "") kept.pop();
  return [...kept, `MAJHI_VERSION=${version}`, ""].join("\n");
}

async function readDotenv(repo: string): Promise<string> {
  return readFile(join(repo, ENV_FILE), "utf8").catch(() => "");
}

async function writeDotenv(repo: string, text: string): Promise<void> {
  const file = join(repo, ENV_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}

/** The commit tag `tag` names in the checkout. Undefined when the checkout has no such tag. */
async function tagCommit(ctx: GitContext, tag: string): Promise<string | undefined> {
  const commit = await guardedGit(ctx, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`])
    .then((out) => out.trim())
    .catch(() => "");
  return COMMIT.test(commit) ? commit : undefined;
}

/** The release the pointer names, with its commit, read from package metadata or legacy Git tags. */
async function latestRelease(ctx: GitContext, url: string, latest: LatestFn): Promise<Release> {
  const tag = await latest(url);
  if (await readPackage(ctx.repo)) {
    const release = releaseIn(await readDotenv(ctx.repo));
    if (!release?.downloadUrl) throw new Error("The runtime install names no MAJHI_DOWNLOAD_URL");
    const metadata = await readPublishedPackage(release.downloadUrl, tag);
    return { tag, commit: metadata.commit };
  }
  const here = await tagCommit(ctx, tag);
  if (here !== undefined) return { tag, commit: here };
  await guardedGit(ctx, ["fetch", "--quiet", "--tags", UPLOAD_PACK, "origin"], false, FETCH_TIMEOUT_MS);
  const fetched = await tagCommit(ctx, tag);
  if (fetched === undefined) throw new Error(`The release ${tag} is not in the checkout's remote`);
  return { tag, commit: fetched };
}

/**
 * What an update would run, for the version check: a dev checkout's HEAD, or on a release install
 * the latest release, asked at most every CHECK_EVERY_MS. A failed ask keeps the last answer.
 */
export function createTargetReader(
  ctx: GitContext,
  deps: { now?: () => number; latest?: LatestFn } = {},
): () => Promise<RepoState | undefined> {
  const now = deps.now ?? Date.now;
  const latest = deps.latest ?? readLatest;
  let askedAt = Number.NEGATIVE_INFINITY;
  let target: Release | undefined;
  return async () => {
    const state = await readRepo(ctx);
    if (state === undefined) return undefined;
    const release = releaseIn(await readDotenv(ctx.repo));
    if (release?.latestUrl === undefined) return state;
    if (now() - askedAt >= CHECK_EVERY_MS) {
      askedAt = now();
      target = await latestRelease(ctx, release.latestUrl, latest).catch(() => target);
    }
    return target === undefined || target.tag === release.version
      ? state
      : { ...state, commit: target.commit };
  };
}

/** Previous release files and settings, so a failed update can put them back. */
export interface Moved {
  from: string;
  to: string;
  head: string;
  dotenv: string;
  files?: Record<string, string>;
}

/**
 * On a release install, updates runtime files or the legacy checkout and `.env`. Undefined on
 * a dev checkout, without a pointer, or when it runs that release already. Throws when the pointer
 * or the tag cannot be read; nothing has moved then.
 */
export async function moveToLatest(
  ctx: GitContext,
  head: string,
  say: (text: string) => Promise<void>,
  latest: LatestFn = readLatest,
): Promise<Moved | undefined> {
  const dotenv = await readDotenv(ctx.repo);
  const release = releaseIn(dotenv);
  if (release === undefined) return undefined;
  if (release.latestUrl === undefined) {
    await say(`.env names no MAJHI_LATEST_URL, so majhi stays on ${release.version}`);
    return undefined;
  }
  await say("Looking for the latest release");
  const target = await latestRelease(ctx, release.latestUrl, latest);
  if (target.tag === release.version) return undefined;
  await say(`Moving from majhi ${release.version} to ${target.tag}`);
  const packaged = await readPackage(ctx.repo);
  let files: Record<string, string> | undefined;
  if (packaged) {
    if (!release.downloadUrl) throw new Error("The runtime install names no MAJHI_DOWNLOAD_URL");
    files = await replacePackage(ctx, { version: target.tag, commit: target.commit }, release.downloadUrl);
  } else {
    await checkout(ctx, `refs/tags/${target.tag}`);
  }
  try {
    await writeDotenv(ctx.repo, withVersion(dotenv, target.tag));
  } catch (err) {
    if (files) await writeRuntime(ctx.repo, files);
    else await checkout(ctx, head);
    throw err;
  }
  return { from: release.version, to: target.tag, head, dotenv, ...(files ? { files } : {}) };
}

/** Restores the runtime files or legacy checkout and `.env`. */
export async function moveBack(ctx: GitContext, moved: Moved): Promise<void> {
  if (moved.files) await writeRuntime(ctx.repo, moved.files);
  else await checkout(ctx, moved.head);
  await writeDotenv(ctx.repo, moved.dotenv);
}

async function checkout(ctx: GitContext, ref: string): Promise<void> {
  await guardedGit(
    ctx,
    ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", ref],
    true,
    CHECKOUT_TIMEOUT_MS,
  );
}

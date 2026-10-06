import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UPLOAD_PACK } from "./gitGuard.ts";
import { type GitContext, guardedGit, type RepoState, readRepo } from "./repoInfo.ts";

/**
 * A release install (install.sh) keeps a checkout of a release tag and names it in the checkout's
 * `.env` as MAJHI_VERSION, so compose takes that release's images. A dev checkout has no
 * MAJHI_VERSION and builds what is on disk. An update on a release install first moves the checkout
 * to the newest release; the build after it is the same `docker compose build` either way.
 */

/** A release tag. The newest is the highest version, as install.sh picks it. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const VERSION_LINE = /^\s*MAJHI_VERSION\s*=(.*)$/;
const ENV_FILE = ".env";
/** How often a release install asks the remote for new tags. */
export const FETCH_EVERY_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const CHECKOUT_TIMEOUT_MS = 120_000;

export interface Release {
  tag: string;
  commit: string;
}

/** The last MAJHI_VERSION in a `.env` text, without quotes. Undefined when there is none. */
export function versionIn(dotenv: string): string | undefined {
  let found: string | undefined;
  for (const line of dotenv.split(/\r?\n/)) {
    const value = VERSION_LINE.exec(line)?.[1];
    if (value !== undefined) found = value.trim().replace(/^["']|["']$/g, "");
  }
  return found === "" ? undefined : found;
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

/** The release this checkout runs. Undefined on a dev checkout. */
export async function installedVersion(repo: string): Promise<string | undefined> {
  return versionIn(await readDotenv(repo));
}

/** Fetches the remote's tags into the checkout. */
export async function fetchReleases(ctx: GitContext): Promise<void> {
  await guardedGit(ctx, ["fetch", "--quiet", "--tags", UPLOAD_PACK, "origin"], false, FETCH_TIMEOUT_MS);
}

/** The newest release tag in the checkout and its commit. Undefined when there is none. */
export async function newestRelease(ctx: GitContext): Promise<Release | undefined> {
  const tags = await guardedGit(ctx, ["tag", "--list", "v*", "--sort=-v:refname"]);
  const tag = tags
    .split("\n")
    .map((t) => t.trim())
    .find((t) => RELEASE_TAG.test(t));
  if (tag === undefined) return undefined;
  const commit = (
    await guardedGit(ctx, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`])
  ).trim();
  return COMMIT.test(commit) ? { tag, commit } : undefined;
}

/**
 * What an update would run, for the version check: a dev checkout's HEAD, or on a release install
 * the newest release, whose tags are fetched at most every FETCH_EVERY_MS.
 */
export function createTargetReader(
  ctx: GitContext,
  now: () => number = Date.now,
): () => Promise<RepoState | undefined> {
  let fetchedAt = Number.NEGATIVE_INFINITY;
  return async () => {
    const state = await readRepo(ctx);
    if (state === undefined) return undefined;
    const installed = await installedVersion(ctx.repo);
    if (installed === undefined) return state;
    if (now() - fetchedAt >= FETCH_EVERY_MS) {
      fetchedAt = now();
      await fetchReleases(ctx).catch(() => undefined);
    }
    const newest = await newestRelease(ctx).catch(() => undefined);
    return newest === undefined || newest.tag === installed ? state : { ...state, commit: newest.commit };
  };
}

/** Where a release install was before an update moved it, so a failed update can put it back. */
export interface Moved {
  from: string;
  to: string;
  head: string;
  dotenv: string;
}

/**
 * On a release install, moves the checkout and `.env` to the newest release. Undefined when this is
 * a dev checkout or it already runs the newest release. Throws when the tags cannot be fetched.
 */
export async function moveToNewest(
  ctx: GitContext,
  head: string,
  say: (text: string) => Promise<void>,
): Promise<Moved | undefined> {
  const dotenv = await readDotenv(ctx.repo);
  const from = versionIn(dotenv);
  if (from === undefined) return undefined;
  await say("Looking for the newest release");
  await fetchReleases(ctx);
  const newest = await newestRelease(ctx);
  if (newest === undefined || newest.tag === from) return undefined;
  await say(`Moving from majhi ${from} to ${newest.tag}`);
  await checkout(ctx, `refs/tags/${newest.tag}`);
  await writeDotenv(ctx.repo, withVersion(dotenv, newest.tag));
  return { from, to: newest.tag, head, dotenv };
}

/** Puts the checkout and `.env` back where `moveToNewest` found them. */
export async function moveBack(ctx: GitContext, moved: Moved): Promise<void> {
  await checkout(ctx, moved.head);
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

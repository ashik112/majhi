import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ReleasePackage, ReleasePackageSchema } from "@majhi/shared";
import { z } from "zod";
import { isMissing, removeDurableFile, writeDurableJson, writeDurableText } from "./durableFile.ts";
import type { GitContext } from "./repoInfo.ts";

export const RUNTIME_FILES = [
  "Dockerfile",
  "docker-compose.yml",
  "docker/owner.sh",
  "docker/laya.Dockerfile",
  "scripts/check.sh",
  "scripts/compose.sh",
  "scripts/host.sh",
  "scripts/lib.sh",
  "scripts/up.sh",
  "install.sh",
  "LICENSE",
  "release.json",
] as const;

export const RuntimeFilesSchema = z.record(z.enum([...RUNTIME_FILES, ".env"]), z.string());
const ROLLBACK_FILE = ".majhi-runtime-rollback.json";
const RollbackSchema = z.object({ version: z.literal(1), files: RuntimeFilesSchema });

/** A helper restart restores every original file, even if the previous restore was interrupted. */
export async function recoverPackage(repo: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(repo, ROLLBACK_FILE), "utf8");
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
  const journal = RollbackSchema.parse(JSON.parse(text));
  await writeRuntime(repo, journal.files);
  await commitPackage(repo);
  return true;
}

export async function commitPackage(repo: string): Promise<void> {
  await removeDurableFile(join(repo, ROLLBACK_FILE));
}

/** Undefined only when this is a source checkout. Invalid package metadata fails closed. */
export async function readPackage(repo: string): Promise<ReleasePackage | undefined> {
  let text: string;
  try {
    text = await readFile(join(repo, "release.json"), "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
    throw err;
  }
  return ReleasePackageSchema.parse(JSON.parse(text));
}

export async function readPublishedPackage(base: string, version: string): Promise<ReleasePackage> {
  // Validate the version before it can become a path component.
  ReleasePackageSchema.shape.version.parse(version);
  const res = await fetch(`${base.replace(/\/$/, "")}/${version}/release.json`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The release metadata answered ${res.status}`);
  const parsed = ReleasePackageSchema.parse(await res.json());
  if (parsed.version !== version) throw new Error("The release metadata names another version");
  return parsed;
}

/** Refuse symlink destinations, including parents, before replacing runtime files. */
async function regularDestination(repo: string, file: string): Promise<void> {
  const paths = [repo, ...(file.includes("/") ? [join(repo, dirname(file))] : []), join(repo, file)];
  for (const path of paths) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`The runtime path is a symbolic link: ${file}`);
    if (path === join(repo, file) && !info.isFile())
      throw new Error(`The runtime file is not regular: ${file}`);
  }
}

export async function writeRuntime(repo: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await regularDestination(repo, file);
    await writeDurableText(join(repo, file), text);
  }
}

/** Download and validate before changing any installed files. Keep old files for update rollback. */
export async function replacePackage(
  ctx: GitContext,
  target: ReleasePackage,
  downloadUrl: string,
): Promise<Record<string, string>> {
  await recoverPackage(ctx.repo);
  const previous: Record<string, string> = {};
  for (const file of [...RUNTIME_FILES, ".env"]) {
    await regularDestination(ctx.repo, file);
    previous[file] = await readFile(join(ctx.repo, file), "utf8");
  }
  const stage = await mkdtemp(join(dirname(ctx.repo), ".majhi-update-"));
  try {
    const app = join(stage, "app");
    await ctx.exec("/bin/sh", [join(ctx.repo, "install.sh")], {
      cwd: ctx.repo,
      env: {
        ...ctx.env,
        MAJHI_APP_DIR: app,
        MAJHI_VERSION: target.version,
        MAJHI_DOWNLOAD_URL: downloadUrl,
        MAJHI_INSTALL_ONLY: "1",
      },
      timeout: 6 * 60_000,
    });
    const downloaded = await readPackage(app);
    if (downloaded?.version !== target.version || downloaded.commit !== target.commit)
      throw new Error("The downloaded package does not match the published release");
    const files: Record<string, string> = {};
    for (const file of RUNTIME_FILES) files[file] = await readFile(join(app, file), "utf8");
    await writeDurableJson(
      join(ctx.repo, ROLLBACK_FILE),
      RollbackSchema.parse({ version: 1, files: previous }),
    );
    try {
      await writeRuntime(ctx.repo, files);
    } catch (err) {
      await recoverPackage(ctx.repo);
      throw err;
    }
    return previous;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ReleasePackage, ReleasePackageSchema } from "@majhi/shared";
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
    const target = join(repo, file);
    const temp = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temp, text, { flag: "wx", mode: 0o600 });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }
}

/** Download and validate before changing any installed files. Keep old files for update rollback. */
export async function replacePackage(
  ctx: GitContext,
  target: ReleasePackage,
  downloadUrl: string,
): Promise<Record<string, string>> {
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
    try {
      await writeRuntime(ctx.repo, files);
    } catch (err) {
      await writeRuntime(ctx.repo, previous);
      throw err;
    }
    return previous;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

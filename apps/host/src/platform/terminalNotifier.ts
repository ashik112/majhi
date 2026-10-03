/**
 * terminal-notifier, which majhi installs itself on macOS so a click on a notification opens majhi at
 * the page (osascript's notifications come from Script Editor and a click opens Script Editor). The
 * release is pinned by URL and SHA-256 (decision of 2026-10-04): nothing else is ever unpacked.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Download } from "../download.ts";
import { errorMessage } from "../errors.ts";
import type { PlatformDeps } from "./types.ts";

export interface NotifierRelease {
  version: string;
  url: string;
  /** Of the zip, lower-case hex. */
  sha256: string;
}

export const TERMINAL_NOTIFIER: NotifierRelease = {
  version: "3.1.0",
  url: "https://github.com/julienXX/terminal-notifier/releases/download/3.1.0/terminal-notifier-3.1.0.zip",
  sha256: "e969d4ae20287da1ba55495ae31dcedd8e9069deb8ce4eed24f6561a5fc3e4d5",
};

const DITTO = "/usr/bin/ditto";
const UNPACK_TIMEOUT_MS = 30_000;
/** After a failed download, the next notification tries again only after this long. */
export const RETRY_MS = 60 * 60_000;
/** Where the program sits inside the release zip, and inside the install folder. */
const PROGRAM = join("terminal-notifier.app", "Contents", "MacOS", "terminal-notifier");

/** `<MAJHI_HOME>/bin/terminal-notifier`, which holds terminal-notifier.app. */
export function installDir(majhiHome: string): string {
  return join(majhiHome, "bin", "terminal-notifier");
}

/** The program majhi installed, whether or not it is there yet. */
export function installedProgram(majhiHome: string): string {
  return join(installDir(majhiHome), PROGRAM);
}

type InstallResult = { kind: "installed"; program: string } | { kind: "mismatch" } | { kind: "failed" };

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

/**
 * Downloads the pinned release, checks its SHA-256, unpacks it in a temporary folder next to the
 * install folder and renames it into place, so a half-done install is never used. Never throws.
 */
async function install(
  deps: PlatformDeps,
  download: Download,
  release: NotifierRelease,
): Promise<InstallResult> {
  const bin = join(deps.majhiHome, "bin");
  let work: string | undefined;
  try {
    const bytes = await download(release.url);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== release.sha256) {
      deps.log(
        `notify: the terminal-notifier ${release.version} download did not match its pinned SHA-256 (got ${hash}); it was discarded and notifications stay on osascript`,
      );
      return { kind: "mismatch" };
    }
    await mkdir(bin, { recursive: true });
    work = await mkdtemp(join(bin, ".terminal-notifier-"));
    const zip = join(work, "release.zip");
    const unpacked = join(work, "unpacked");
    await writeFile(zip, bytes, { mode: 0o600 });
    const done = await deps.run(DITTO, ["-x", "-k", zip, unpacked], {
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: UNPACK_TIMEOUT_MS,
    });
    if (done.code !== 0 || !(await isFile(join(unpacked, PROGRAM)))) {
      deps.log("notify: could not unpack terminal-notifier; notifications stay on osascript");
      return { kind: "failed" };
    }
    const target = installDir(deps.majhiHome);
    // Only a broken install can be here: a working one is found before an install starts.
    await rm(target, { recursive: true, force: true });
    await rename(unpacked, target);
    deps.log(`notify: installed terminal-notifier ${release.version} in ${target}`);
    return { kind: "installed", program: installedProgram(deps.majhiHome) };
  } catch (err) {
    deps.log(`notify: could not install terminal-notifier: ${errorMessage(err)}`);
    return { kind: "failed" };
  } finally {
    if (work !== undefined) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Returns a function giving the terminal-notifier to use: majhi's own copy, else one on PATH. When
 * there is none and `deps.download` is set, it starts the install in the background and gives
 * undefined, so this notification goes through osascript and a later one uses the new copy. A
 * checksum mismatch stops tries until the helper restarts; other failures retry after an hour.
 */
export function terminalNotifier(
  deps: PlatformDeps,
  release: NotifierRelease = TERMINAL_NOTIFIER,
  now: () => number = Date.now,
): () => Promise<string | undefined> {
  const own = installedProgram(deps.majhiHome);
  let ready: string | undefined;
  let installing = false;
  let retryAt = 0;

  return async () => {
    if (ready !== undefined) return ready;
    if (await deps.exists(own)) {
      ready = own;
      return own;
    }
    const onPath = await deps.find("terminal-notifier");
    if (onPath !== undefined) return onPath;
    const download = deps.download;
    if (download !== undefined && !installing && now() >= retryAt) {
      installing = true;
      deps.log(`notify: installing terminal-notifier ${release.version} so a click opens majhi`);
      void install(deps, download, release).then((result) => {
        installing = false;
        if (result.kind === "installed") ready = result.program;
        else retryAt = result.kind === "mismatch" ? Number.POSITIVE_INFINITY : now() + RETRY_MS;
      });
    }
    return undefined;
  };
}

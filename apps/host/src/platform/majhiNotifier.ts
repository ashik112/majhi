/**
 * majhi's own notifier on macOS: a small app named majhi, with the majhi icon and its own bundle id
 * (`dev.majhi.alerts`), built on the owner's Mac with `swiftc` and signed ad hoc, so macOS lists
 * its notifications under "majhi" and a click opens the page. Nothing is downloaded and nothing is
 * signed with a certificate. Without the Command Line Tools it is not built, and the helper falls back
 * to terminal-notifier (see `macNotifier`).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../errors.ts";
import { NOTIFIER_ICON_PNG_BASE64 } from "./majhiNotifierIcon.ts";
import { NOTIFIER_SWIFT } from "./majhiNotifierSource.ts";
import type { PlatformDeps } from "./types.ts";

export const NOTIFIER_BUNDLE_ID = "dev.majhi.alerts";
/** The notifier's exit code when macOS has notifications off for it. terminal-notifier uses it too. */
export const NOTIFIER_OFF_CODE = 3;
/** Its exit code when the owner has not been asked yet. `authorize` asks. */
export const NOTIFIER_NOT_ASKED_CODE = 5;

const XCODE_SELECT = "/usr/bin/xcode-select";
const SWIFTC = "/usr/bin/swiftc";
const SIPS = "/usr/bin/sips";
const ICONUTIL = "/usr/bin/iconutil";
const CODESIGN = "/usr/bin/codesign";
const EXECUTABLE = "majhi-notifier";
const BUILD_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 30_000;
/** After a failed build, the next notification tries again only after this long. */
export const BUILD_RETRY_MS = 60 * 60_000;

function infoPlist(stamp: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${NOTIFIER_BUNDLE_ID}</string>
<key>CFBundleName</key><string>majhi</string>
<key>CFBundleDisplayName</key><string>majhi</string>
<key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1</string>
<key>CFBundleIconFile</key><string>majhi</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>MajhiBuild</key><string>${stamp}</string>
</dict></plist>
`;
}

/** Names the source and icon this helper builds from, so a newer helper rebuilds an older app. */
export const NOTIFIER_STAMP = createHash("sha256")
  .update(NOTIFIER_SWIFT)
  .update(NOTIFIER_ICON_PNG_BASE64)
  .digest("hex")
  .slice(0, 16);

/** `<MAJHI_HOME>/bin/majhi-notifier/majhi.app`. */
export function notifierApp(majhiHome: string): string {
  return join(majhiHome, "bin", "majhi-notifier", "majhi.app");
}

export function notifierProgram(majhiHome: string): string {
  return join(notifierApp(majhiHome), "Contents", "MacOS", EXECUTABLE);
}

/** True when the installed app was built from this helper's source. Reads only the plist. */
export async function notifierIsCurrent(majhiHome: string): Promise<boolean> {
  const text = await readFile(join(notifierApp(majhiHome), "Contents", "Info.plist"), "utf8").catch(
    () => undefined,
  );
  return text?.includes(`<string>${NOTIFIER_STAMP}</string>`) === true;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

export type BuildResult = { kind: "built"; program: string } | { kind: "unsupported" } | { kind: "failed" };

/** The sizes an .icns holds, as the iconset's file names. */
const ICONSET: readonly (readonly [name: string, px: number])[] = [
  ["icon_16x16", 16],
  ["icon_16x16@2x", 32],
  ["icon_32x32", 32],
  ["icon_32x32@2x", 64],
  ["icon_128x128", 128],
  ["icon_128x128@2x", 256],
  ["icon_256x256", 256],
  ["icon_256x256@2x", 512],
  ["icon_512x512", 512],
];

/**
 * Builds the app in a temporary folder next to the install folder: compile, icon, ad-hoc signature, then
 * a check that the signature holds and the program starts and reads its permission. Only a verified app is
 * renamed into place, so a half-done build is never used. Never throws.
 */
export async function buildNotifier(deps: PlatformDeps): Promise<BuildResult> {
  const select = await deps.run(XCODE_SELECT, ["-p"], {
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: STEP_TIMEOUT_MS,
  });
  if (select.code !== 0 || !(await deps.exists(SWIFTC))) {
    deps.log("notify: the Command Line Tools are not installed, so majhi's own notifier is not built");
    return { kind: "unsupported" };
  }
  const bin = join(deps.majhiHome, "bin");
  let work: string | undefined;
  try {
    await mkdir(bin, { recursive: true });
    work = await mkdtemp(join(bin, ".majhi-notifier-"));
    const app = join(work, "majhi.app");
    const contents = join(app, "Contents");
    const program = join(contents, "MacOS", EXECUTABLE);
    const resources = join(contents, "Resources");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(resources, { recursive: true });
    const env = { PATH: "/usr/bin:/bin", HOME: deps.home, TMPDIR: work };
    const step = async (file: string, args: string[], timeoutMs = STEP_TIMEOUT_MS) =>
      deps.run(file, args, { env, timeoutMs });

    const source = join(work, "notifier.swift");
    await writeFile(source, NOTIFIER_SWIFT);
    await writeFile(join(contents, "Info.plist"), infoPlist(NOTIFIER_STAMP));
    const compiled = await step(
      SWIFTC,
      ["-O", "-swift-version", "5", "-module-cache-path", join(work, "modules"), source, "-o", program],
      BUILD_TIMEOUT_MS,
    );
    if (compiled.code !== 0 || !(await isFile(program))) {
      deps.log(`notify: swiftc did not build the notifier: ${compiled.stderr.trim().slice(0, 300)}`);
      return { kind: "failed" };
    }

    // The icon is a nicety: without it the app still works, with the generic one.
    const iconset = join(work, "majhi.iconset");
    await mkdir(iconset, { recursive: true });
    const png = join(work, "majhi-512.png");
    await writeFile(png, Buffer.from(NOTIFIER_ICON_PNG_BASE64, "base64"));
    let iconOk = true;
    for (const [name, px] of ICONSET) {
      const sized = await step(SIPS, [
        "-z",
        String(px),
        String(px),
        png,
        "--out",
        join(iconset, `${name}.png`),
      ]);
      if (sized.code !== 0) iconOk = false;
    }
    const icns = iconOk
      ? await step(ICONUTIL, ["-c", "icns", iconset, "-o", join(resources, "majhi.icns")])
      : undefined;
    if (icns?.code !== 0) deps.log("notify: majhi's notifier has no icon, the icon tools did not run");

    const signed = await step(CODESIGN, ["--force", "--sign", "-", app]);
    const checked = await step(CODESIGN, ["--verify", "--strict", app]);
    if (signed.code !== 0 || checked.code !== 0) {
      deps.log("notify: the notifier's ad-hoc signature did not verify");
      return { kind: "failed" };
    }
    // 0 allowed, 5 not asked yet, 3 off for it: all three mean it built and runs. Anything else does not.
    const status = await deps.run(program, ["status"], { env, timeoutMs: STEP_TIMEOUT_MS });
    if (![0, NOTIFIER_NOT_ASKED_CODE, NOTIFIER_OFF_CODE].includes(status.code ?? -1)) {
      deps.log(`notify: the built notifier did not start (exit ${String(status.code)})`);
      return { kind: "failed" };
    }

    const target = join(bin, "majhi-notifier");
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await rename(app, notifierApp(deps.majhiHome));
    deps.log(`notify: built majhi's notifier in ${notifierApp(deps.majhiHome)}`);
    return { kind: "built", program: notifierProgram(deps.majhiHome) };
  } catch (err) {
    deps.log(`notify: could not build majhi's notifier: ${errorMessage(err)}`);
    return { kind: "failed" };
  } finally {
    if (work !== undefined) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

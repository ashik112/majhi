/**
 * macOS notifications. majhi's own notifier app (named majhi, with the majhi icon, a click opens the
 * page) is preferred; terminal-notifier is the fallback where it cannot be built. osascript is never
 * used: macOS shows its notifications as Script Editor's, and a click opens Script Editor.
 *
 * The result comes from the program's exit code, never from its message: 0 shown, 3 notifications are
 * off for it in System Settings, anything else failed. When they are off the helper shows nothing
 * and says `blocked`, so the app can ask the owner for the one step that fixes it.
 */

import {
  BUILD_RETRY_MS,
  buildNotifier,
  NOTIFIER_NOT_ASKED_CODE,
  NOTIFIER_OFF_CODE,
  notifierIsCurrent,
  notifierProgram,
} from "./majhiNotifier.ts";
import type { NotifierRelease } from "./terminalNotifier.ts";
import { TERMINAL_NOTIFIER, terminalNotifier } from "./terminalNotifier.ts";
import type { Notifier, NotifyOutcome, NotifyRequest, PlatformDeps } from "./types.ts";

const OPEN = "/usr/bin/open";
const NOTIFY_TIMEOUT_MS = 10_000;
/**
 * macOS asks the owner for permission at the first notification, and a program that is ended while
 * the question is on screen counts as a No, for good. So a question never runs under the short
 * timeout: majhi's app is asked with `authorize` and this long wait, and terminal-notifier, which asks
 * inside its first post, gets it until its first success.
 */
const ASK_TIMEOUT_MS = 24 * 60 * 60_000;
const SETTINGS_URL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

type Program = { kind: "majhi" | "terminal-notifier"; path: string };

/** The arguments each program takes. `-group majhi` keeps terminal-notifier's together. */
function argsFor(program: Program, request: NotifyRequest): string[] {
  if (program.kind === "majhi") {
    const args = ["post", "--title", request.title, "--message", request.message];
    if (request.url !== undefined) args.push("--url", request.url);
    if (request.sound) args.push("--sound");
    return args;
  }
  const args = ["-title", request.title, "-message", request.message, "-group", "majhi"];
  if (request.url !== undefined) args.push("-open", request.url);
  if (request.sound) args.push("-sound", "Glass");
  return args;
}

/** A notification waits this long for a build that is under way, then is not shown. */
const BUILD_WAIT_MS = 8_000;

/** Resolves when `work` ends or after `ms`, whichever is first. */
function within(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void work.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** `release` is the terminal-notifier release to fall back to. Tests pin their own. */
export function macNotifier(
  deps: PlatformDeps,
  release: NotifierRelease = TERMINAL_NOTIFIER,
  now: () => number = Date.now,
): Notifier {
  const findTerminalNotifier = terminalNotifier(deps, release, now);
  let building: Promise<void> | undefined;
  let retryAt = 0;
  let unsupported = false;
  let shownOnce = false;
  let asking: Promise<void> | undefined;

  const build = (): Promise<void> | undefined => {
    if (building !== undefined) return building;
    if (unsupported || now() < retryAt) return undefined;
    deps.log("notify: building majhi's own notifier so notifications show as majhi");
    building = buildNotifier(deps)
      .then((result) => {
        if (result.kind === "unsupported") unsupported = true;
        else if (result.kind === "failed") retryAt = now() + BUILD_RETRY_MS;
      })
      .finally(() => {
        building = undefined;
      });
    return building;
  };

  /** The program to use now, or undefined while nothing is ready. */
  const find = async (): Promise<Program | undefined> => {
    const own = notifierProgram(deps.majhiHome);
    if (await deps.exists(own)) {
      // An app from an older helper keeps working while a newer one is built.
      if (!(await notifierIsCurrent(deps.majhiHome))) void build();
      return { kind: "majhi", path: own };
    }
    const pending = build();
    if (pending !== undefined) {
      await within(pending, BUILD_WAIT_MS);
      if (await deps.exists(own)) return { kind: "majhi", path: own };
      // Still building: nothing is shown for these seconds, and `prepare` at start avoids them.
      if (building !== undefined) return undefined;
    }
    const fallback = await findTerminalNotifier();
    return fallback === undefined ? undefined : { kind: "terminal-notifier", path: fallback };
  };

  /**
   * Asks the owner for permission, once at a time, without waiting for the answer. A Yes shows later
   * as a notification that works; a No stays what it is until the owner changes it in Settings.
   */
  const ask = (program: Program): void => {
    if (asking !== undefined || program.kind !== "majhi") return;
    deps.log("notify: asking macOS to allow notifications for majhi");
    asking = deps
      .run(program.path, ["authorize"], { env: { PATH: deps.path }, timeoutMs: ASK_TIMEOUT_MS })
      .then((done) => {
        deps.log(`notify: macOS answered the notification question (exit ${String(done.code)})`);
      })
      .finally(() => {
        asking = undefined;
      });
  };

  return {
    async prepare() {
      // Waits for a build, then a failed or impossible one leaves terminal-notifier to install.
      await find();
      if (building !== undefined) {
        await building;
        await find();
      }
      // The question comes now, while the owner is likely at the Mac, not at the first alert.
      const program = await find();
      if (program?.kind !== "majhi") return;
      const status = await deps.run(program.path, ["status"], {
        env: { PATH: deps.path },
        timeoutMs: NOTIFY_TIMEOUT_MS,
      });
      if (status.code === NOTIFIER_NOT_ASKED_CODE) ask(program);
    },
    async show(request): Promise<NotifyOutcome> {
      const program = await find();
      if (program === undefined) return { kind: "unavailable" };
      const timeoutMs =
        program.kind === "terminal-notifier" && !shownOnce ? ASK_TIMEOUT_MS : NOTIFY_TIMEOUT_MS;
      const done = await deps.run(program.path, argsFor(program, request), {
        env: { PATH: deps.path },
        timeoutMs,
      });
      if (done.code === 0) {
        shownOnce = true;
        return { kind: "shown", clickable: request.url !== undefined };
      }
      if (done.code === NOTIFIER_OFF_CODE) return { kind: "blocked" };
      // The owner has not answered the question yet: it is asked now, and until they say Yes it is off.
      if (done.code === NOTIFIER_NOT_ASKED_CODE) {
        ask(program);
        return { kind: "blocked" };
      }
      return { kind: "failed", error: "macOS did not show the notification." };
    },
    async openSettings() {
      const done = await deps.run(OPEN, [SETTINGS_URL], {
        env: { PATH: deps.path, HOME: deps.home },
        timeoutMs: NOTIFY_TIMEOUT_MS,
      });
      return done.code === 0;
    },
  };
}

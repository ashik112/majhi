import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UPDATE_STATUS_FILE, type UpdateStatus, UpdateStatusSchema } from "@majhi/shared";
import { removeOtherReleases, removeOwnLeftovers } from "./diskHygiene.ts";
import { isMissing, writeDurableJson } from "./durableFile.ts";
import { errorMessage } from "./errors.ts";
import type { KeyBackup } from "./keyBackup.ts";
import type { Logger } from "./log.ts";
import { type LatestFn, type Moved, moveBack, moveToLatest } from "./release.ts";
import { commitPackage, readPackage, recoverPackage } from "./releasePackage.ts";
import { dockerStep, OVERRIDE_FILE, type RemountOptions, regenerateAndUp } from "./remount.ts";
import { type GitContext, readRepo } from "./repoInfo.ts";

import {
  clearUpdateJournal,
  readUpdateJournal,
  type UpdateJournal,
  writeUpdateJournal,
} from "./updateJournal.ts";

const BUILD_TIMEOUT_MS = 20 * 60_000;
const KEY_TIMEOUT_MS = 60_000;
const MAX_LINES = 40;
/** The image `docker-compose.yml` builds and runs. */
export const IMAGE = "majhi-server:dev";
/** The image that ran before the last update, kept so a failed update can go back to it. */
const RUNNER_IMAGE = "majhi-runner:dev";
const PREVIOUS_RUNNER_IMAGE = "majhi-runner:previous";
const RECOVERY_IMAGE = "majhi-server:update-recovery";
const DATABASE_DIR = "update-databases";
const PREVIOUS_IMAGE = "majhi-server:previous";
/** Laya's image and container, built and started with the server's when Laya runs in Docker. */
const LAYA_IMAGE = "majhi-laya:dev";
const PREVIOUS_LAYA_IMAGE = "majhi-laya:previous";
const LAYA_CONTAINER = "majhi-laya";
/** PyTorch for CUDA when `.env` names no other, as in the Makefile. */
const CUDA_TORCH_INDEX = "https://download.pytorch.org/whl/cu130";
/** Lines of the server's log searched for why it did not start. */
const LOG_LINES = 40;

export interface UpdateOptions {
  remount: RemountOptions;
  git: GitContext;
  /** `<MAJHI_HOME>`, where `update.json` is written. */
  majhiHome: string;
  /** Where the installed helper bundle lives, `<MAJHI_HOME>/bin/majhi-host.mjs`. */
  bundle: string;
  /** The file this helper runs from. The helper only exits to be replaced when it is the bundle. */
  selfPath: string;
  secretsKeyFile: string;
  /** The keyring copy of the secrets key: put back when the file is gone, made after a new key. */
  keyBackup?: Pick<KeyBackup, "read" | "ensure" | "where">;
  log: Logger;
  now?: () => Date;
  /** Ends the process so the login service (launchd or systemd) starts the new helper. Tests pass a spy. */
  exit: () => void;
  /** Waits before exiting, so the last status write and log line reach disk. */
  sleep?: (ms: number) => Promise<void>;
  /** Reads the latest-release pointer on a release install. Tests pass a fake. */
  latest?: LatestFn;
}

/**
 * Returns a function that rebuilds majhi from the checkout and restarts it, as `make up` does:
 * build with the same environment and the commit baked in, keep the secrets key, regenerate the
 * mounts, `up -d --wait`, then install the helper from the new image and let the login service
 * restart it. On a release install it first updates runtime files or the legacy checkout (release.ts),
 * and the same build then takes that release's images instead of compiling: compose decides.
 * It reports to `update.json` because the server that would relay progress is replaced part-way.
 * It never throws. Returns false when an update is already running.
 */
export function createUpdater(options: UpdateOptions): () => boolean {
  let running = false;
  return () => {
    if (running) return false;
    running = true;
    void runUpdate(options)
      .catch((err: unknown) => options.log(`update: ${errorMessage(err)}`))
      .finally(() => {
        running = false;
      });
    return true;
  };
}

async function runUpdate(options: UpdateOptions): Promise<void> {
  const { remount, git, majhiHome, log } = options;
  const now = options.now ?? (() => new Date());
  const file = join(majhiHome, UPDATE_STATUS_FILE);
  const status: UpdateStatus = {
    state: "running",
    commit: "",
    startedAt: now().toISOString(),
    lines: [],
  };
  const write = async (): Promise<void> => {
    const temp = `${file}.${process.pid}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, JSON.stringify(status));
    await rename(temp, file);
  };
  const say = async (text: string): Promise<void> => {
    log(`update: ${text}`);
    status.lines = [...status.lines, text].slice(-MAX_LINES);
    await write().catch(() => undefined);
  };

  let pendingMove: Moved | undefined;
  const restorePackage = async (): Promise<void> => {
    if (pendingMove === undefined) return;
    const moved = pendingMove;
    pendingMove = undefined;
    await putBack(git, moved, say);
  };

  try {
    await recoverUpdate(options);
    await say("Reading the installed version");
    const before = await readRepo(git);
    if (before === undefined)
      throw new Error("The majhi folder has neither a runtime package nor a source checkout.");
    const moved = await moveToLatest(git, before.commit, say, options.latest);
    pendingMove = moved;
    const repo = moved === undefined ? before : ((await readRepo(git)) ?? before);
    status.commit = repo.commit;
    if (repo.dirty) await say("The folder has changes you have not committed. They are part of this build.");

    // The same environment `make up` gives compose, plus the commit the image should carry.
    const base = { ...remount.env, MAJHI_COMMIT: repo.commit };
    const laya = await layaInDocker(dockerStep({ ...remount, env: base }, "update"), base);
    const env = laya ? await layaEnv(remount.repo, base) : base;
    const step = dockerStep({ ...remount, env }, "update");
    const images: Array<[Kept["image"], string]> = [
      [IMAGE, PREVIOUS_IMAGE],
      [RUNNER_IMAGE, PREVIOUS_RUNNER_IMAGE],
    ];
    if (laya) images.push([LAYA_IMAGE, PREVIOUS_LAYA_IMAGE]);
    const previous: Kept[] = [];
    for (const [image, keep] of images) {
      const id = await keepPrevious(step, image, keep);
      if (id !== undefined) previous.push({ image, id });
    }
    const mounts = await readFile(join(remount.repo, OVERRIDE_FILE), "utf8").catch(() => undefined);
    const journal: UpdateJournal = {
      version: 1,
      phase: "prepared",
      previous,
      ...(mounts === undefined ? {} : { mounts }),
      ...(moved === undefined ? {} : { moved }),
    };
    await writeUpdateJournal(majhiHome, journal);
    await say(
      moved !== undefined
        ? `Getting the majhi ${moved.to} images`
        : (await readPackage(git.repo)) !== undefined
          ? "Getting the installed release images"
          : "Building the new image. This takes a few minutes",
    );
    // The runner image too: agents run in it (it is never started by compose). Laya's as `make up` does.
    const build = ["compose", "--profile", "runner", ...(laya ? ["--profile", "laya"] : []), "build"];
    await buildWithRetries(() => step("build", build, BUILD_TIMEOUT_MS), {
      say,
      sleep: options.sleep ?? defaultSleep,
    });

    try {
      await ensureSecretsKey(options, env, say);
      await step("keep the database recovery tool", ["tag", IMAGE, RECOVERY_IMAGE], KEY_TIMEOUT_MS);
      journal.phase = "snapshotting";
      await writeUpdateJournal(majhiHome, journal);
      await step("stop majhi before its database snapshot", ["compose", "stop", "server"], KEY_TIMEOUT_MS);
      await databaseStep(options, step, "update-snapshot");
      journal.phase = "starting";
      await writeUpdateJournal(majhiHome, journal);
      await regenerateAndUp({ ...remount, env }, "update", (text) => void say(text));
    } catch (err) {
      const reason = await crashReason(step);
      if (reason !== undefined) await say(`The new majhi said: ${reason}`);
      const server = previous.some((kept) => kept.image === IMAGE);
      await say(
        server
          ? "The new majhi did not start. Going back to the previous version"
          : "No previous version to go back to",
      );
      throw new Error(`${errorMessage(err)}${reason === undefined ? "" : `\n${reason}`}`);
    }

    // The new server passed its health check. From here the installed release is committed.
    journal.phase = "committed";
    await writeUpdateJournal(majhiHome, journal);
    pendingMove = undefined;
    await finishTransaction(options, step);
    await cleanAfterUpdate(
      step,
      say,
      majhiHome,
      images.map(([, keep]) => keep),
    );
    if (moved !== undefined) await removeOtherReleases(step, moved.to, say).catch(() => undefined);
    await say("Installing the new host helper");
    const replaced = await installBundle(options, env);
    status.state = "done";
    await say(replaced ? "Done. Restarting the host helper" : "Done");
    if (replaced && options.selfPath === options.bundle) {
      await (options.sleep ?? defaultSleep)(500);
      options.exit();
    }
  } catch (err) {
    let recoveryError: unknown;
    try {
      const transaction = await readUpdateJournal(majhiHome);
      if (transaction) {
        await recoverUpdate(options, say);
        pendingMove = undefined;
        await say(
          transaction.phase === "committed"
            ? "The new version is running"
            : "Went back to the previous version",
        );
      } else await restorePackage();
    } catch (back) {
      recoveryError = back;
      await say(`Recovery is still pending: ${errorMessage(back)}`);
    }
    status.state = "failed";
    status.error = `${errorMessage(err)}${recoveryError === undefined ? "" : `\nRecovery is still pending: ${errorMessage(recoveryError)}`}`;
    await say(`Failed: ${errorMessage(err).split("\n", 1)[0]}`);
  }
}

/** The new image's CLI takes snapshots without starting the server or migrating either database. */
async function databaseStep(
  options: UpdateOptions,
  step: Step,
  command: "update-snapshot" | "update-restore",
): Promise<void> {
  const home = options.majhiHome;
  const user =
    options.remount.env.HOST_UID && options.remount.env.HOST_GID
      ? ["--user", `${options.remount.env.HOST_UID}:${options.remount.env.HOST_GID}`]
      : [];
  await step(
    command,
    [
      "run",
      "--rm",
      "--network",
      "none",
      ...user,
      "--mount",
      `type=bind,source=${home},target=${home}`,
      "--env",
      `MAJHI_HOME=${home}`,
      RECOVERY_IMAGE,
      "node",
      "dist/cli.js",
      command,
    ],
    BUILD_TIMEOUT_MS,
  );
}

async function finishTransaction(options: UpdateOptions, step: Step): Promise<void> {
  await commitPackage(options.git.repo);
  await rm(join(options.majhiHome, DATABASE_DIR), { recursive: true, force: true });
  await clearUpdateJournal(options.majhiHome);
  await step("remove the database recovery tool", ["image", "rm", RECOVERY_IMAGE], KEY_TIMEOUT_MS).catch(
    () => undefined,
  );
}

async function reportRecoveredUpdate(options: UpdateOptions, committed: boolean): Promise<void> {
  const file = join(options.majhiHome, UPDATE_STATUS_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }
  const status = UpdateStatusSchema.parse(JSON.parse(text));
  if (status.state !== "running") return;
  status.state = committed ? "done" : "failed";
  if (!committed)
    status.error = "An interrupted update was recovered. Majhi is back on the previous version.";
  status.lines = [
    ...status.lines,
    committed
      ? "Update completed; recovery files removed"
      : "Recovered the previous version after an interrupted update",
  ].slice(-MAX_LINES);
  await writeDurableJson(file, status);
}

/** Run before accepting host jobs. Recovery remains on disk until every rollback step succeeds. */
export async function recoverUpdate(
  options: UpdateOptions,
  say?: (text: string) => Promise<void>,
): Promise<void> {
  const journal = await readUpdateJournal(options.majhiHome);
  if (journal === undefined) {
    await recoverPackage(options.git.repo);
    return;
  }
  const step = dockerStep(options.remount, "update recovery");
  if (journal.phase === "committed") {
    await finishTransaction(options, step);
    if (!say) await reportRecoveredUpdate(options, true);
    return;
  }
  options.log("update recovery: restoring the interrupted update");
  // Stop first, including after a helper crash while the new server was already running.
  if (journal.phase !== "prepared") {
    await step("stop majhi for recovery", ["compose", "stop", "server"], KEY_TIMEOUT_MS);
    if (journal.phase === "starting") await databaseStep(options, step, "update-restore");
  }
  if (journal.moved) {
    await moveBack(options.git, journal.moved);
    await say?.(`Back on majhi ${journal.moved.from}`);
  } else await recoverPackage(options.git.repo);
  await goBack(step, options.remount.repo, journal.previous, journal.mounts, journal.phase !== "prepared");
  journal.phase = "committed";
  await writeUpdateJournal(options.majhiHome, journal);
  await finishTransaction(options, step);
  if (!say) await reportRecoveredUpdate(options, false);
}

/**
 * `make up` creates the key when it is missing. The helper does the same, so a fresh computer needs
 * no terminal. A key the keyring still holds comes back first: a new key could not read `secrets.age`.
 */
async function ensureSecretsKey(
  options: UpdateOptions,
  env: NodeJS.ProcessEnv,
  say: (text: string) => Promise<void>,
): Promise<void> {
  const { remount, secretsKeyFile, keyBackup } = options;
  const present = await stat(secretsKeyFile).then(
    (s) => s.size > 0,
    () => false,
  );
  if (present) return;
  const saved = await keyBackup?.read();
  if (saved !== undefined && keyBackup !== undefined) {
    await say(`Putting back the secrets key from ${keyBackup.where}`);
    await writeKey(secretsKeyFile, `${saved}\n`);
    return;
  }
  await say("Creating the secrets key");
  const step = dockerStep({ ...remount, env }, "update");
  const key = await step(
    "create secrets key",
    // Not `compose run`: compose refuses to start while the secret file it names is missing.
    ["run", "--rm", "--pull", "never", IMAGE, "node", "dist/cli.js", "gen-key"],
    KEY_TIMEOUT_MS,
  );
  if (key.trim() === "") throw new Error("create secrets key printed nothing");
  await writeKey(secretsKeyFile, key);
  await keyBackup?.ensure();
}

async function writeKey(file: string, key: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  await writeFile(temp, key, { mode: 0o600 });
  await rename(temp, file);
}

/** Copies the helper out of the new image over the installed bundle. The running process keeps its loaded copy. */
async function installBundle(options: UpdateOptions, env: NodeJS.ProcessEnv): Promise<boolean> {
  const { remount, bundle, log } = options;
  const step = dockerStep({ ...remount, env }, "update");
  let id = "";
  try {
    id = (await step("create a copy of the image", ["create", IMAGE], KEY_TIMEOUT_MS)).trim();
    await mkdir(dirname(bundle), { recursive: true });
    const temp = `${bundle}.tmp`;
    await step("copy the helper out", ["cp", `${id}:/app/host/majhi-host.mjs`, temp], KEY_TIMEOUT_MS);
    await rename(temp, bundle);
    return true;
  } catch (err) {
    log(`update: could not replace the helper: ${errorMessage(err)}`);
    await rm(`${bundle}.tmp`, { force: true });
    return false;
  } finally {
    if (id !== "") await step("remove the copy", ["rm", id], KEY_TIMEOUT_MS).catch(() => undefined);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Step = ReturnType<typeof dockerStep>;

/** An image that ran before the update: its tag and the id the tag pointed at. */
interface Kept {
  image: UpdateJournal["previous"][number]["image"];
  id: string;
}

/**
 * Whether `make up` runs Laya in Docker. It records its mode in MAJHI_LAYA. A helper installed
 * before that has no record: Laya is in Docker when `make up` gave it the GPU or its container exists.
 */
async function layaInDocker(step: Step, env: NodeJS.ProcessEnv): Promise<boolean> {
  const mode = env.MAJHI_LAYA?.trim();
  if (mode) return mode === "docker";
  if (env.MAJHI_LAYA_GPU === "nvidia") return true;
  return step(
    "find Laya's container",
    ["container", "inspect", "--format", "{{.Id}}", LAYA_CONTAINER],
    KEY_TIMEOUT_MS,
  )
    .then((out) => out.trim() !== "")
    .catch(() => false);
}

/**
 * The environment that builds and starts Laya as `make up` does: its profile, so `up` recreates it,
 * and on an NVIDIA GPU the CUDA build args. `make up` records those; without the record they are
 * worked out as the Makefile does, and a torch index in `.env` reaches compose on its own.
 */
async function layaEnv(repo: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const profiles = (env.COMPOSE_PROFILES ?? "").split(",").filter((p) => p !== "" && p !== "laya");
  const out: NodeJS.ProcessEnv = { ...env, COMPOSE_PROFILES: [...profiles, "laya"].join(",") };
  if (env.MAJHI_LAYA_GPU !== "nvidia") return out;
  out.MAJHI_LAYA_DEVICE ||= "cuda";
  if (!out.MAJHI_LAYA_TORCH_INDEX) {
    const dotenv = await readFile(join(repo, ".env"), "utf8").catch(() => "");
    if (!/^\s*MAJHI_LAYA_TORCH_INDEX\s*=/m.test(dotenv)) out.MAJHI_LAYA_TORCH_INDEX = CUDA_TORCH_INDEX;
  }
  return out;
}

/** Tags the image majhi runs now, so the build cannot orphan it. Undefined when there is none yet. */
async function keepPrevious(step: Step, image: string, keep: string): Promise<string | undefined> {
  const id = await step(
    "find the running image",
    ["image", "inspect", "--format", "{{.Id}}", image],
    KEY_TIMEOUT_MS,
  )
    .then((out) => out.trim())
    .catch(() => "");
  if (id === "") return undefined;
  await step("keep the running image", ["tag", id, keep], KEY_TIMEOUT_MS);
  return id;
}

/**
 * After a successful update and health check: removes majhi's own old images (see diskHygiene.ts).
 * It never prunes the build cache or anything unlabelled. Best effort: a failed clean-up never
 * fails an update that already runs.
 */
export async function cleanAfterUpdate(
  step: Step,
  say: (text: string) => Promise<void>,
  majhiHome: string,
  tags: readonly string[],
): Promise<void> {
  await say("Removing the old majhi images");
  await removeOwnLeftovers(step, majhiHome, say, tags).catch(() => undefined);
}

/** Restores a release install's runtime files or checkout and `.env`. */
async function putBack(git: GitContext, moved: Moved, say: (text: string) => Promise<void>): Promise<void> {
  await moveBack(git, moved).then(
    () => say(`Back on majhi ${moved.from}`),
    (err: unknown) => say(`Could not restore majhi ${moved.from}: ${errorMessage(err).split("\n", 1)[0]}`),
  );
}

/** Puts the previous images and mounts back and starts majhi on them. */
async function goBack(
  step: Step,
  repo: string,
  previous: Kept[],
  mounts: string | undefined,
  restart = true,
): Promise<void> {
  for (const { image, id } of previous) {
    await step("go back to the previous image", ["tag", id, image], KEY_TIMEOUT_MS);
  }
  if (mounts !== undefined) {
    const target = join(repo, OVERRIDE_FILE);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, mounts);
    await rename(temp, target);
  }
  if (!restart) return;
  if (!previous.some((kept) => kept.image === IMAGE))
    throw new Error("No previous server image is available for recovery");
  await step("start the previous majhi", ["compose", "up", "-d", "--wait"], BUILD_TIMEOUT_MS);
}

/** The last error-looking line of the server's log, the reason `--wait` only calls "unhealthy". */
async function crashReason(step: Step): Promise<string | undefined> {
  const log = await step(
    "read the server log",
    ["compose", "logs", "--no-color", "--no-log-prefix", "--tail", String(LOG_LINES), "server"],
    KEY_TIMEOUT_MS,
  ).catch(() => "");
  const lines = log
    .split("\n")
    .map((l) => l.replace(/^[\w.-]+\s+\|\s?/, "").trim())
    .filter((l) => l !== "");
  return [...lines].reverse().find((l) => /error|exception|failed|cannot|refused/i.test(l));
}

/** Waits before the 2nd and 3rd try of a build that failed because the network did not answer. */
export const BUILD_RETRY_MS = [15_000, 45_000] as const;

/** A build error from the network, not from the code: DNS, TLS, timeouts, resets. */
export function looksLikeNetwork(message: string): boolean {
  return /no such host|TLS handshake timeout|i\/o timeout|connection reset|connection refused|network is unreachable|failed to fetch oauth token|failed to do request|temporary failure in name resolution|EAI_AGAIN|ETIMEDOUT/i.test(
    message,
  );
}

/** Runs the build, trying again on network errors; the last error says so in plain words. */
async function buildWithRetries(
  build: () => Promise<unknown>,
  deps: { say: (text: string) => Promise<void>; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await build();
      return;
    } catch (err) {
      const message = errorMessage(err);
      if (!looksLikeNetwork(message)) throw err;
      const wait = BUILD_RETRY_MS[attempt];
      if (wait === undefined) {
        throw new Error(
          `build failed: the image registry could not be reached after ${attempt + 1} tries. Check your internet connection, then update again.\n${message}`,
        );
      }
      await deps.say(
        `The image registry did not answer. Trying again in ${Math.round(wait / 1000)} seconds (${attempt + 2} of ${BUILD_RETRY_MS.length + 1})`,
      );
      await deps.sleep(wait);
    }
  }
}

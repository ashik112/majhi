import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UPDATE_STATUS_FILE, type UpdateStatus } from "@majhi/shared";
import { errorMessage } from "./errors.ts";
import type { Logger } from "./log.ts";
import { dockerStep, type RemountOptions, regenerateAndUp } from "./remount.ts";
import { type GitContext, readRepo } from "./repoInfo.ts";

const BUILD_TIMEOUT_MS = 20 * 60_000;
const KEY_TIMEOUT_MS = 60_000;
const MAX_LINES = 40;
/** The image `docker-compose.yml` builds and runs. */
export const IMAGE = "majhi-server:dev";

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
  log: Logger;
  now?: () => Date;
  /** Ends the process so launchd starts the new helper. Tests pass a spy. */
  exit: () => void;
  /** Waits before exiting, so the last status write and log line reach disk. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Returns a function that rebuilds majhi from the checkout and restarts it, as `make up` does:
 * build with the same environment and the commit baked in, keep the secrets key, regenerate the
 * mounts, `up -d --wait`, then install the helper from the new image and let launchd restart it.
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

  try {
    await say("Reading the code on disk");
    const repo = await readRepo(git);
    if (repo === undefined)
      throw new Error("The majhi folder is not a git checkout, so there is nothing to build.");
    status.commit = repo.commit;
    if (repo.dirty) await say("The folder has changes you have not committed. They are part of this build.");

    // The same environment `make up` gives compose, plus the commit the image should carry.
    const env = { ...remount.env, MAJHI_COMMIT: repo.commit };
    const step = dockerStep({ ...remount, env }, "update");
    await say("Building the new image. This takes a few minutes");
    await step("build", ["compose", "build"], BUILD_TIMEOUT_MS);

    await ensureSecretsKey(options, env, say);
    await regenerateAndUp({ ...remount, env }, "update", (text) => void say(text));

    await say("Installing the new host helper");
    const replaced = await installBundle(options, env);
    status.state = "done";
    await say(replaced ? "Done. Restarting the host helper" : "Done");
    if (replaced && options.selfPath === options.bundle) {
      await (options.sleep ?? defaultSleep)(500);
      options.exit();
    }
  } catch (err) {
    status.state = "failed";
    status.error = errorMessage(err);
    await say(`Failed: ${errorMessage(err).split("\n", 1)[0]}`);
  }
}

/** `make up` creates the key when it is missing. The helper does the same, so a fresh Mac needs no terminal. */
async function ensureSecretsKey(
  options: UpdateOptions,
  env: NodeJS.ProcessEnv,
  say: (text: string) => Promise<void>,
): Promise<void> {
  const { remount, secretsKeyFile } = options;
  const present = await stat(secretsKeyFile).then(
    (s) => s.size > 0,
    () => false,
  );
  if (present) return;
  await say("Creating the secrets key");
  const step = dockerStep({ ...remount, env }, "update");
  const key = await step(
    "create secrets key",
    // Not `compose run`: compose refuses to start while the secret file it names is missing.
    ["run", "--rm", "--pull", "never", IMAGE, "node", "dist/cli.js", "gen-key"],
    KEY_TIMEOUT_MS,
  );
  if (key.trim() === "") throw new Error("create secrets key printed nothing");
  await mkdir(dirname(secretsKeyFile), { recursive: true, mode: 0o700 });
  const temp = `${secretsKeyFile}.tmp`;
  await writeFile(temp, key, { mode: 0o600 });
  await rename(temp, secretsKeyFile);
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

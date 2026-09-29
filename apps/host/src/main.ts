/**
 * majhi host helper: runs on the owner's machine, outside Docker, and does
 * the few jobs the container cannot: list host folders, suggest workspace
 * roots, and remount roots by recreating the server container. It opens no
 * port; it polls the server (SPEC 4.2).
 */
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HostInfo } from "@majhi/shared";
import { type LinkOptions, pollLoop, sendReply } from "./client.ts";
import { parseHostConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { runJob } from "./jobs.ts";
import { listDirs } from "./listDirs.ts";
import { createFileLogger } from "./log.ts";
import { findExecutable, toolPath } from "./paths.ts";
import { composeEnv, createRemounter, dockerStep, type ExecFn, type RemountOptions } from "./remount.ts";
import { commitSubjects, createHostFacts, type GitContext, readRepo } from "./repoInfo.ts";
import { runCommand } from "./runCommand.ts";
import { createSsh, discoverPublicKeys } from "./ssh.ts";
import { notificationScript, type StartupDeps, startAtLogin } from "./startup.ts";
import { suggestRoots } from "./suggestRoots.ts";
import { ensureToken } from "./token.ts";
import { createUpdater } from "./update.ts";

const exec: ExecFn = promisify(execFile);

const FACTS_REFRESH_MS = 30_000;

const files = {
  readText: (file: string) => readFile(file, "utf8").catch(() => undefined),
  exists: (file: string) =>
    access(file).then(
      () => true,
      () => false,
    ),
};

async function main(): Promise<void> {
  const config = parseHostConfig();
  const publicKeys = () => discoverPublicKeys({ ...files, home: config.home });
  if (process.argv.includes("--ssh-pubkeys")) {
    // For `make up`: the .pub files to mount, one per line. Nothing else is printed.
    for (const key of await publicKeys()) process.stdout.write(`${key}\n`);
    return;
  }
  const log = createFileLogger(join(config.majhiHome, "logs", "host.log"));
  await ensureToken(config.majhiHome);

  const path = toolPath(process.env.PATH);
  const docker = config.repo === undefined ? undefined : await findExecutable("docker", path);
  const remountOptions =
    config.repo === undefined || docker === undefined
      ? undefined
      : {
          repo: config.repo,
          docker,
          env: composeEnv(process.env, {
            home: config.home,
            uid: process.getuid?.() ?? 0,
            gid: process.getgid?.() ?? 0,
            path,
          }),
          exec,
          log,
          sshPublicKeys: publicKeys,
        };
  const remount = remountOptions === undefined ? undefined : createRemounter(remountOptions);
  const gitBin = await findExecutable("git", path);
  const gitContext: GitContext | undefined =
    config.repo === undefined || gitBin === undefined
      ? undefined
      : { git: gitBin, repo: config.repo, env: { ...process.env, PATH: path }, exec };
  const facts = createHostFacts({ git: gitContext, docker, env: { ...process.env, PATH: path }, exec });
  await facts.refresh();
  const factsTimer = setInterval(() => void facts.refresh(), FACTS_REFRESH_MS);
  factsTimer.unref();
  const bundle = join(config.majhiHome, "bin", "majhi-host.mjs");
  const update =
    remountOptions === undefined || gitContext === undefined
      ? undefined
      : createUpdater({
          remount: remountOptions,
          git: gitContext,
          majhiHome: config.majhiHome,
          bundle,
          selfPath: process.argv[1] ?? "",
          secretsKeyFile:
            process.env.MAJHI_SECRETS_KEY ?? join(config.home, ".config", "majhi", "secrets.key"),
          log,
          exit: () => process.exit(0),
        });

  const ssh = createSsh({
    run: runCommand,
    ...files,
    home: config.home,
    env: { ...process.env, PATH: path },
    log,
  });
  const info = (): HostInfo => {
    const status = ssh.status();
    const repo = facts.repo();
    const runtime = facts.runtime();
    return {
      version: config.version,
      platform: process.platform,
      canRemount: remount !== undefined,
      ...(status === undefined ? {} : { ssh: status }),
      ...(repo === undefined ? {} : { commit: repo.commit, dirty: repo.dirty }),
      ...(runtime === undefined ? {} : { dockerRuntime: runtime }),
    };
  };
  const link: LinkOptions = { url: config.url, token: () => ensureToken(config.majhiHome), info, log };
  const remounts =
    remount !== undefined
      ? `on, in ${config.repo}`
      : config.repo === undefined
        ? "off, MAJHI_REPO is not set"
        : "off, docker was not found";
  log(
    `majhi host helper ${config.version} started (pid ${process.pid}, ${config.url}, remounts ${remounts})`,
  );

  const stopSsh = ssh.start();
  const controller = new AbortController();
  const stop = (signal: string): void => {
    log(`stopping (${signal})`);
    stopSsh();
    controller.abort();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  const handlers = {
    listDirs: (params: { path: string; showHidden: boolean }) => listDirs(params, config.home),
    suggestRoots: () => suggestRoots(config.home),
    remount,
    sshReload: () => ssh.reload(),
    versionChanges: async (params: { from: string }) => {
      if (gitContext === undefined) throw new Error("This helper has no majhi checkout to read.");
      const repo = await readRepo(gitContext);
      if (repo === undefined) throw new Error("The majhi folder is not a git checkout.");
      return { head: repo.commit, dirty: repo.dirty, changes: await commitSubjects(gitContext, params.from) };
    },
    update,
    restart: () => {
      log("restarting on request");
      setTimeout(() => process.exit(0), 300);
    },
    sshUnlock: (params: { key: string; passphrase: string }) => ssh.unlock(params.key, params.passphrase),
  };
  if (remountOptions !== undefined) {
    // Start Docker and majhi if a login or a restart found them down. It never blocks the poll loop.
    void startAtLogin(startupDeps(remountOptions, config.home, log)).catch((err: unknown) =>
      log(`startup: ${errorMessage(err)}`),
    );
  }
  await pollLoop({
    ...link,
    signal: controller.signal,
    onJob: (job) => {
      log(`job ${job.method} ${job.id}`);
      void runJob(job, handlers, (reply) => sendReply(link, reply));
    },
  });
}

const DOCKER_APPS = ["OrbStack", "Docker"] as const;
const DOCKER_CALL_MS = 15_000;
const COMPOSE_UP_MS = 300_000;

/** The real commands behind the start-at-login flow. Only this file runs them. */
function startupDeps(options: RemountOptions, home: string, log: (message: string) => void): StartupDeps {
  const { docker, repo, env } = options;
  const compose = (args: string[], timeout: number) => exec(docker, args, { cwd: repo, env, timeout });
  return {
    log,
    dockerUp: () =>
      exec(docker, ["info", "--format", "{{.ID}}"], { cwd: repo, env, timeout: DOCKER_CALL_MS }).then(
        () => true,
        () => false,
      ),
    openDocker: async () => {
      for (const app of DOCKER_APPS) {
        for (const dir of ["/Applications", join(home, "Applications")]) {
          if (await files.exists(join(dir, `${app}.app`))) {
            await exec("/usr/bin/open", ["-a", app], { cwd: "/", env, timeout: DOCKER_CALL_MS });
            log(`startup: opened ${app}`);
            return true;
          }
        }
      }
      return false;
    },
    majhiRunning: async () => {
      try {
        const { stdout } = await compose(
          ["compose", "ps", "--status", "running", "-q", "server"],
          DOCKER_CALL_MS,
        );
        return stdout.trim() !== "";
      } catch {
        return false;
      }
    },
    startMajhi: async () => {
      await dockerStep(options, "startup")("start majhi", ["compose", "up", "-d", "--wait"], COMPOSE_UP_MS);
    },
    notify: async (message) => {
      await exec("/usr/bin/osascript", ["-e", notificationScript(message)], {
        cwd: "/",
        env,
        timeout: DOCKER_CALL_MS,
      });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

main().catch((err: unknown) => {
  // Goes to stderr, which the LaunchAgent writes to ~/.majhi/logs/host.out. launchd restarts the helper.
  process.stderr.write(`majhi host helper failed: ${errorMessage(err)}\n`);
  process.exit(1);
});

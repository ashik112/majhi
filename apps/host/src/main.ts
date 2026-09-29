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
import { composeEnv, createRemounter, type ExecFn } from "./remount.ts";
import { runCommand } from "./runCommand.ts";
import { createSsh, discoverPublicKeys } from "./ssh.ts";
import { suggestRoots } from "./suggestRoots.ts";
import { ensureToken } from "./token.ts";

const exec: ExecFn = promisify(execFile);

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
  const remount =
    config.repo === undefined || docker === undefined
      ? undefined
      : createRemounter({
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
    const base = { version: config.version, platform: process.platform, canRemount: remount !== undefined };
    return status === undefined ? base : { ...base, ssh: status };
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
    sshUnlock: (params: { key: string; passphrase: string }) => ssh.unlock(params.key, params.passphrase),
  };
  await pollLoop({
    ...link,
    signal: controller.signal,
    onJob: (job) => {
      log(`job ${job.method} ${job.id}`);
      void runJob(job, handlers, (reply) => sendReply(link, reply));
    },
  });
}

main().catch((err: unknown) => {
  // Goes to stderr, which the LaunchAgent writes to ~/.majhi/logs/host.out. launchd restarts the helper.
  process.stderr.write(`majhi host helper failed: ${errorMessage(err)}\n`);
  process.exit(1);
});

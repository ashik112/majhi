/**
 * majhi host helper: runs on the owner's computer, outside Docker, and does
 * the few jobs the container cannot: list host folders, suggest workspace
 * roots, and remount roots by recreating the server container. It opens no
 * port; it polls the server (SPEC 4.2). Everything that differs per OS goes
 * through the `Platform` built here for the OS found at start (platform/).
 */
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { release } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { type HostInfo, keyringName, type LayaQuestion } from "@majhi/shared";
import { type LinkOptions, pollLoop, sendProgress, sendReply } from "./client.ts";
import { CliLogins } from "./cliLogin.ts";
import { CliToolLogins } from "./cliTools.ts";
import { parseHostConfig } from "./config.ts";
import { createEditorOpener, pathKind } from "./editor.ts";
import { errorMessage } from "./errors.ts";
import { ensureAskpass, gitAuthEnv } from "./gitAuth.ts";
import { type GitCloneDeps, gitClone, gitLsRemote } from "./gitClone.ts";
import { detectGitLogins, type GitLoginsDeps, readGitToken } from "./gitLogins.ts";
import { type GitPushDeps, gitCredential, gitPush } from "./gitPush.ts";
import { runJob } from "./jobs.ts";
import { createKeyBackup } from "./keyBackup.ts";
import { createKeyRestorer } from "./keyRestore.ts";
import { createLaya } from "./laya.ts";
import { listDirs } from "./listDirs.ts";
import { createFileLogger, type Logger } from "./log.ts";
import { readMachine } from "./machine.ts";
import { desktopNotifier, plainLine, showNotification } from "./notify.ts";
import { findExecutable } from "./paths.ts";
import { createPlatform, currentOs, nodePlatform, processDeps } from "./platform/index.ts";
import type { Platform } from "./platform/types.ts";
import { createTargetReader } from "./release.ts";
import {
  composeEnv,
  createRemounter,
  dockerStep,
  type ExecFn,
  type RemountOptions,
  recreateServer,
} from "./remount.ts";
import { commitSubjects, createHostFacts, type GitContext } from "./repoInfo.ts";
import { createSsh, discoverPublicKeys } from "./ssh.ts";
import { type StartupDeps, startAtLogin } from "./startup.ts";
import { suggestRoots } from "./suggestRoots.ts";
import { ensureToken } from "./token.ts";
import { createUpdater } from "./update.ts";

const exec: ExecFn = promisify(execFile);

const FACTS_REFRESH_MS = 30_000;
const KEY_BACKUP_REFRESH_MS = 10 * 60_000;
const DOCKER_LOOK_MS = 60_000;

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
  const os = currentOs();
  if (os === undefined) {
    process.stderr.write("majhi's host helper runs on macOS, Linux and WSL2.\n");
    process.exit(1);
  }
  const publicKeys = () => discoverPublicKeys({ ...files, home: config.home });
  if (process.argv.includes("--ssh-pubkeys")) {
    // For `make up`: the .pub files to mount, one per line. Nothing else is printed.
    for (const key of await publicKeys()) process.stdout.write(`${key}\n`);
    return;
  }
  const log = createFileLogger(join(config.majhiHome, "logs", "host.log"));
  await ensureToken(config.majhiHome);

  const deps = processDeps(os, {
    home: config.home,
    majhiHome: config.majhiHome,
    log,
    downloads: config.notify,
  });
  const real = createPlatform(os, deps);
  const platform = { ...real, notifier: desktopNotifier(config.notify, real.notifier, log) };
  // On macOS this builds majhi's own notifier now, so the first notification shows as majhi.
  void platform.notifier.prepare?.().catch((err: unknown) => log(`notify: ${errorMessage(err)}`));
  const path = deps.path;
  const gitBin = await deps.find("git");
  const gitContext: GitContext | undefined =
    config.repo === undefined || gitBin === undefined
      ? undefined
      : { git: gitBin, repo: config.repo, env: { ...process.env, PATH: path }, exec };
  const bundle = join(config.majhiHome, "bin", "majhi-host.mjs");
  const secretsKeyFile =
    process.env.MAJHI_SECRETS_KEY ?? join(config.home, ".config", "majhi", "secrets.key");
  const keyBackup = createKeyBackup({
    keyring: platform.keyring,
    where: keyringName(os),
    readText: files.readText,
    keyFile: secretsKeyFile,
    log,
  });

  // How `docker compose` runs once docker is found. MAJHI_SSH_AGENT is the agent socket the server
  // container gets (decision 1), unless the helper's own environment names one.
  const compose =
    config.repo === undefined
      ? undefined
      : {
          repo: config.repo,
          env: composeEnv(
            {
              ...process.env,
              MAJHI_SSH_AGENT: process.env.MAJHI_SSH_AGENT?.trim() || platform.sshAgent.composeSocket,
            },
            { home: config.home, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, path },
          ),
          exec,
          log,
          sshPublicKeys: publicKeys,
        };
  let remountOptions: RemountOptions | undefined;
  let remount: ReturnType<typeof createRemounter> | undefined;
  let update: ReturnType<typeof createUpdater> | undefined;
  let dockerTimer: NodeJS.Timeout | undefined;
  let started = false;
  /**
   * Looks for docker until it is there, then turns on remount, update and the Docker facts. On WSL2,
   * Docker Desktop puts the CLI into the distro only while it runs, so at login `docker` can be
   * missing or a dangling link (decision 7). Asked at start, while startup waits for Docker, and
   * every minute.
   */
  const findDocker = async (): Promise<RemountOptions | undefined> => {
    if (remountOptions !== undefined || compose === undefined) return remountOptions;
    const docker = await deps.find("docker");
    if (docker === undefined || remountOptions !== undefined) return remountOptions;
    remountOptions = { ...compose, docker };
    remount = createRemounter(remountOptions);
    update =
      gitContext === undefined
        ? undefined
        : createUpdater({
            remount: remountOptions,
            git: gitContext,
            majhiHome: config.majhiHome,
            bundle,
            selfPath: process.argv[1] ?? "",
            secretsKeyFile,
            keyBackup,
            log,
            exit: () => process.exit(0),
          });
    clearInterval(dockerTimer);
    if (started) log(`remounts on: found ${docker}`);
    return remountOptions;
  };
  await findDocker();
  if (compose !== undefined && remountOptions === undefined) {
    dockerTimer = setInterval(() => void findDocker(), DOCKER_LOOK_MS);
    dockerTimer.unref();
  }
  const keyRestore = createKeyRestorer({
    keyFile: secretsKeyFile,
    secretsFile: join(config.majhiHome, "secrets.age"),
    // Read at each restore: majhi can be restarted once docker is found.
    get restart() {
      const options = remountOptions;
      return options === undefined ? undefined : () => recreateServer(options, "secrets key");
    },
    saveToKeyring: (fingerprint) => keyBackup.save(fingerprint),
    log,
  });
  // What an update would run: the checkout's HEAD, or on a release install the latest release.
  const readTarget = gitContext === undefined ? undefined : createTargetReader(gitContext);
  const facts = createHostFacts({
    readTarget,
    docker: () => remountOptions?.docker,
    env: { ...process.env, PATH: path },
    exec,
  });
  await facts.refresh();
  const factsTimer = setInterval(() => void facts.refresh(), FACTS_REFRESH_MS);
  factsTimer.unref();

  const ssh = createSsh({
    run: deps.run,
    ...files,
    home: config.home,
    path,
    find: deps.find,
    agent: platform.sshAgent,
    keyring: platform.keyring,
    log,
    runtimeDir: process.env.XDG_RUNTIME_DIR,
  });
  const editorOpen = createEditorOpener({
    run: deps.run,
    platform: platform.editor,
    env: () => platform.desktopEnv(),
    find: deps.find,
    kind: pathKind,
    isExecutable: async (file) => (await findExecutable(basename(file), dirname(file))) !== undefined,
  });
  const laya = createLaya({
    majhiHome: config.majhiHome,
    home: config.home,
    path,
    osRelease: release(),
    run: deps.run,
    log,
  });
  const gitDeps: GitLoginsDeps = {
    run: deps.run,
    readText: files.readText,
    home: config.home,
    path,
    socket: () => platform.sshAgent.socket(),
    find: deps.find,
  };
  // majhi's own askpass for clones and pushes with a workspace's token (see gitAuth.ts).
  const askpass = await ensureAskpass(config.majhiHome);
  const authDeps = { majhiHome: config.majhiHome, askpass, path, home: config.home };
  const gitPushDeps: GitPushDeps = {
    run: deps.run,
    home: config.home,
    path,
    kind: pathKind,
    authEnv: (auth) => gitAuthEnv(authDeps, auth),
  };
  const gitCloneDeps: GitCloneDeps = { ...authDeps, run: deps.run, socket: gitDeps.socket };
  // The server resumes turns that stalled while the computer slept when it sees this change.
  let wokeAt: string | undefined;
  const info = (): HostInfo => {
    const status = ssh.status();
    const repo = facts.repo();
    const runtime = facts.runtime();
    const keyring = keyBackup.keyring();
    const secretsKey = keyBackup.status();
    return {
      version: config.version,
      platform: nodePlatform,
      os,
      ...(keyring === undefined ? {} : { keyring }),
      canRemount: remount !== undefined,
      ...(status === undefined ? {} : { ssh: status }),
      ...(repo === undefined ? {} : { commit: repo.commit, dirty: repo.dirty }),
      ...(runtime === undefined ? {} : { dockerRuntime: runtime }),
      laya: laya.status(),
      ...(secretsKey === undefined ? {} : { secretsKey }),
      ...(wokeAt === undefined ? {} : { wokeAt }),
    };
  };
  const link: LinkOptions = { url: config.url, token: () => ensureToken(config.majhiHome), info, log };
  const remounts =
    remount !== undefined
      ? `on, in ${config.repo}`
      : config.repo === undefined
        ? "off, MAJHI_REPO is not set"
        : "off until docker is found";
  log(
    `majhi host helper ${config.version} started on ${os} (pid ${process.pid}, ${config.url}, remounts ${remounts})`,
  );
  started = true;

  // A copy of the secrets key in the keyring, made when there is none. Looked at again now and then,
  // so a deleted copy or a keyring that went away shows on Health. It never blocks the poll loop.
  void keyBackup.ensure();
  const keyTimer = setInterval(() => void keyBackup.ensure(), KEY_BACKUP_REFRESH_MS);
  keyTimer.unref();
  // Linux and WSL2: the fixed agent socket the server container uses (decision 2). macOS: nothing.
  const stopForwarder = platform.sshAgent.serve();
  const stopSsh = ssh.start({
    onWake: (at) => {
      wokeAt = at.toISOString();
    },
  });
  const controller = new AbortController();
  const stop = (signal: string): void => {
    log(`stopping (${signal})`);
    stopSsh();
    stopForwarder();
    laya.stop();
    controller.abort();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  const cliLogins = new CliLogins({
    majhiHome: config.majhiHome,
    path,
    find: (cli) => findExecutable(cli, path),
    env: process.env,
  });
  const cliTools = new CliToolLogins({
    majhiHome: config.majhiHome,
    path,
    find: (binary) => findExecutable(binary, path),
    env: process.env,
  });
  const handlers = {
    cliLogin: (
      params: Parameters<CliToolLogins["login"]>[0],
      progress: Parameters<CliToolLogins["login"]>[1],
    ) => cliTools.login(params, progress),
    cliLoginCancel: (params: { signIn: string }) => cliTools.cancel(params.signIn),
    cliCheck: (params: Parameters<CliToolLogins["check"]>[0]) => cliTools.check(params),
    cliLogout: (params: Parameters<CliToolLogins["logout"]>[0]) => cliTools.logout(params),
    listDirs: (params: { path: string; showHidden: boolean }) => listDirs(params, config.home),
    suggestRoots: () => suggestRoots(config.home, platform.folders.skippedAtHome),
    // Read at each job: remount and update turn on once docker is found.
    get remount() {
      return remount;
    },
    sshReload: () => ssh.reload(),
    editorOpen,
    machineRead: () => readMachine({ os, exec, home: config.home, env: { ...process.env, PATH: path } }),
    versionChanges: async (params: { from: string }) => {
      if (gitContext === undefined || readTarget === undefined)
        throw new Error("This helper has no majhi checkout to read.");
      const repo = await readTarget();
      if (repo === undefined) throw new Error("The majhi folder is not a git checkout.");
      return {
        head: repo.commit,
        dirty: repo.dirty,
        changes: await commitSubjects(gitContext, params.from, repo.commit),
      };
    },
    get update() {
      return update;
    },
    restart: () => {
      log("restarting on request");
      setTimeout(() => process.exit(0), 300);
    },
    sshUnlock: (params: { key: string; passphrase: string }) => ssh.unlock(params.key, params.passphrase),
    secretsKeySave: (params: { expected: string }) => keyBackup.save(params.expected),
    secretsKeyRestore: keyRestore,
    gitLogins: async (params: { extraHosts: string[] }) => ({
      hosts: await detectGitLogins(gitDeps, params.extraHosts),
    }),
    gitToken: (params: { via: "gh" | "glab"; host: string }) =>
      readGitToken(gitDeps, params.via, params.host),
    gitPush: (params: Parameters<typeof gitPush>[1]) => gitPush(gitPushDeps, params),
    openUrl: (params: { url: string }) => platform.openUrl(params.url),
    clipboardCopy: (params: { text: string }) => platform.clipboardCopy(params.text),
    gitClone: (params: Parameters<typeof gitClone>[1], progress: Parameters<typeof gitClone>[2]) =>
      gitClone(gitCloneDeps, params, progress),
    gitLsRemote: (params: Parameters<typeof gitLsRemote>[1]) => gitLsRemote(gitCloneDeps, params),
    gitCliLogin: (params: Parameters<CliLogins["login"]>[0], progress: Parameters<CliLogins["login"]>[1]) =>
      cliLogins.login(params, progress),
    gitCliLoginCancel: (params: { signIn: string }) => cliLogins.cancel(params.signIn),
    gitCredential: (params: { host: string; username: string }) => gitCredential(gitPushDeps, params),
    notify: (params: { title: string; message: string; path?: string | undefined; sound: boolean }) =>
      showNotification(platform.notifier, config.url, params),
    notifyOpenSettings: () => platform.notifier.openSettings?.() ?? Promise.resolve(false),
    layaStatus: () => laya.status(),
    layaInstall: () => laya.install(),
    layaDecide: (params: { state: string; questions: Record<string, LayaQuestion> }) => laya.decide(params),
  };
  if (compose !== undefined) {
    // Start Docker and majhi if a login or a restart found them down. It never blocks the poll loop.
    void startAtLogin(startupDeps(findDocker, platform, log)).catch((err: unknown) =>
      log(`startup: ${errorMessage(err)}`),
    );
  }
  await pollLoop({
    ...link,
    signal: controller.signal,
    onJob: (job) => {
      log(`job ${job.method} ${job.id}`);
      void runJob(
        job,
        handlers,
        (reply) => sendReply(link, reply),
        (progress) => sendProgress(link, progress),
      );
    },
  });
}

const DOCKER_CALL_MS = 15_000;
const COMPOSE_UP_MS = 300_000;

/**
 * The real commands behind the start-at-login flow. Only this file runs them. Docker is looked for
 * at each step, so a CLI that appears once Docker started is used.
 */
function startupDeps(
  findDocker: () => Promise<RemountOptions | undefined>,
  platform: Pick<Platform, "docker" | "notifier">,
  log: Logger,
): StartupDeps {
  const found = async (): Promise<RemountOptions> => {
    const options = await findDocker();
    if (options === undefined) throw new Error("docker was not found");
    return options;
  };
  const compose = async (args: string[], timeout: number) => {
    const { docker, repo, env } = await found();
    return exec(docker, args, { cwd: repo, env, timeout });
  };
  return {
    log,
    dockerUp: () =>
      compose(["info", "--format", "{{.ID}}"], DOCKER_CALL_MS).then(
        () => true,
        () => false,
      ),
    docker: platform.docker,
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
      await dockerStep(await found(), "startup")(
        "start majhi",
        ["compose", "up", "-d", "--wait"],
        COMPOSE_UP_MS,
      );
    },
    notify: async (message) => {
      await platform.notifier.show({
        title: "majhi",
        message: plainLine(message),
        url: undefined,
        sound: false,
      });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

main().catch((err: unknown) => {
  // Goes to stderr, which the login service (the LaunchAgent on macOS, the systemd user unit on
  // Linux and WSL2) appends to ~/.majhi/logs/host.out, and the service restarts the helper.
  process.stderr.write(`majhi host helper failed: ${errorMessage(err)}\n`);
  process.exit(1);
});

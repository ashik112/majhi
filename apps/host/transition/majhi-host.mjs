// majhi host helper: transition shim. Dependency-free, Node 18 or newer, standard library only.
//
// Until this release the host helper was a Node program, and an install's updater copied this file
// (`/app/host/majhi-host.mjs`) out of the new image over ~/.majhi/bin/majhi-host.mjs and let launchd or
// systemd start it again. The helper is a Go binary now. This file is what such an install runs once:
// it copies the binary for this computer out of the same image, then hands over to
// `majhi-host install-service --from-legacy`, which rewrites the login service to run the binary
// directly, loads it and removes this file. Nothing is left for the owner to do.
//
// It can go once no install can still be on a Node helper: when the oldest release that is still
// updated from (docs/DECISIONS.md, 2026-10-21, "transition shim") was made with the Go helper.
//
// If a step fails it writes one plain line to ~/.majhi/logs/host.log and tries again in 60 seconds. It
// stays alive meanwhile, so the service manager never throttles it.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binary = join(here, "majhi-host");
const majhiHome = process.env.MAJHI_HOME || dirname(here);
const image = process.env.MAJHI_HOST_IMAGE || "majhi-server:dev";
const retryMs = 60_000;
const logFile = join(majhiHome, "logs", "host.log");
const lockFile = join(majhiHome, "run", "install-service.lock");
const attemptFile = join(majhiHome, "run", "shim-attempt");

function log(message) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    process.stderr.write(`${message}\n`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const age = (file) => {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/** The name of the binary in the image for this computer. */
function imageName() {
  const os = { darwin: "darwin", linux: "linux" }[process.platform];
  const cpu = { arm64: "arm64", x64: "amd64" }[process.arch];
  if (!os || !cpu) throw new Error(`this helper has no build for ${process.platform} on ${process.arch}`);
  return `majhi-host-${os}-${cpu}`;
}

function docker(args) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      `docker ${args[0]} did not work (is Docker running, and is docker on the PATH of the login service?)`,
    );
  }
}

/** Copies the binary out of the image into place. A temporary file, then a rename. */
function install() {
  const temp = `${binary}.switch.tmp`;
  const id = docker(["create", image]);
  try {
    mkdirSync(here, { recursive: true });
    docker(["cp", `${id}:/app/host/${imageName()}`, temp]);
  } finally {
    try {
      docker(["rm", id]);
    } catch {
      // The copy is what counts.
    }
  }
  chmodSync(temp, 0o755);
  if (process.platform === "darwin" && existsSync("/usr/bin/codesign")) {
    try {
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", temp], {
        stdio: "ignore",
        timeout: 30_000,
      });
    } catch {
      // Unsigned still runs, and the Go linker signs arm64 builds already.
    }
  }
  renameSync(temp, binary);
}

/** Starts the Go half in a session of its own, so it outlives this job when the service is reloaded. */
function handOver() {
  const args = ["install-service", "--from-legacy", "--wait-pid", String(process.pid)];
  let file = binary;
  let argv = args;
  if (process.platform === "linux") {
    // systemd ends everything in the unit's cgroup when it restarts it, a new session or not: a
    // transient unit of its own survives that. The login service's variables go with it.
    try {
      execFileSync("systemd-run", ["--version"], { stdio: "ignore", timeout: 10_000 });
      const set = Object.entries(process.env).flatMap(([k, v]) =>
        v === undefined ? [] : [`--setenv=${k}=${v}`],
      );
      file = "systemd-run";
      argv = ["--user", "--collect", "--quiet", "--unit=majhi-host-switch", ...set, "--", binary, ...args];
    } catch {
      // No systemd-run: a detached process is the best there is.
    }
  }
  const child = spawn(file, argv, { detached: true, stdio: "ignore", env: process.env });
  child.on("error", (err) => log(`transition: could not start the new helper (${err.message}).`));
  child.unref();
}

async function main() {
  mkdirSync(dirname(lockFile), { recursive: true });
  // The service manager starts this file again as soon as it exits. While the switch runs it only waits.
  while (age(lockFile) < 5 * 60_000) await sleep(5_000);
  // After a failed try, the next one waits out its minute, whoever started it.
  const since = age(attemptFile);
  if (since < retryMs) await sleep(retryMs - since);
  for (;;) {
    try {
      writeFileSync(attemptFile, `${new Date().toISOString()}\n`);
      utimesSync(attemptFile, new Date(), new Date());
      install();
      handOver();
      return;
    } catch (err) {
      log(
        `transition: the helper is changing from Node to a program of its own, and this step failed: ${err.message}. Trying again in 60 seconds.`,
      );
      await sleep(retryMs);
    }
  }
}

await main();
// Nothing else is needed from this process. The Go half waits for it to be gone before it takes over.
rmSync(`${binary}.switch.tmp`, { force: true });
process.exit(0);

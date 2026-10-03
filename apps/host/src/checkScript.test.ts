import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeOs, type Sandbox, type ScriptResult, scriptSandbox } from "./testing/scripts.ts";

/** `docker info --format '{{json .OperatingSystem}} {{json .SecurityOptions}}'` per runtime. */
const ENGINE = `"Ubuntu 24.04.1 LTS" ["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]`;
const DESKTOP = `"Docker Desktop" ["name=seccomp,profile=unconfined","name=cgroupns"]`;
const ORBSTACK = `"OrbStack" ["name=seccomp,profile=builtin","name=cgroupns"]`;
const ROOTLESS = `"Ubuntu 24.04.1 LTS" ["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]`;
const RUNTIME: Record<FakeOs, string> = { linux: ENGINE, wsl: DESKTOP, macos: ORBSTACK };

const NOT_RUNNING =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
const ENGINE_STEP =
  "Switch to Docker Engine running as root (https://docs.docker.com/engine/install/): sudo systemctl enable --now docker, then docker context use default, then make up again.";

let sb: Sandbox;
let env: Record<string, string>;
beforeEach(async () => {
  sb = await scriptSandbox();
  env = { MAJHI_NODE: join(sb.bin, "node") };
});
afterEach(() => sb.cleanup());

/** `docker` answering `info` with `info` (or failing with `infoError`) and `compose version` with `compose`. */
function docker(options: { info?: string; infoError?: string; compose?: string | null }): Promise<void> {
  const info =
    options.infoError === undefined
      ? `echo '${options.info ?? ENGINE}'`
      : `echo '${options.infoError}' >&2; exit 1`;
  const compose =
    options.compose === null
      ? `echo "docker: 'compose' is not a docker command." >&2; exit 1`
      : `echo ${options.compose ?? "2.29.7"}`;
  return sb.fake("docker", `case "$1" in info) ${info} ;; compose) ${compose} ;; esac`);
}

/** A computer with everything: Docker for its OS, git, Node, an unlocked keyring and systemd. */
async function healthy(os: FakeOs): Promise<void> {
  await sb.os(os);
  await docker({ info: RUNTIME[os] });
  await sb.fake("git", "exit 0");
  await sb.fake("node", "exit 0");
  await sb.fake("secret-tool", "exit 0");
  await sb.fake("busctl", "echo 'b false'");
  await sb.fake("systemctl", "echo Version=255");
}

const check = (extra: Record<string, string> = {}) => sb.run("check.sh", [], { ...env, ...extra });
const WSL = { WSL_DISTRO_NAME: "Ubuntu" };

/** The one line a failed check prints. */
function failLine(result: ScriptResult): string {
  expect(result.code).toBe(1);
  const lines = result.stderr.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return lines[0] ?? "";
}

/** The warnings of a check that went on. */
function warnings(result: ScriptResult): string[] {
  expect(result.code).toBe(0);
  return result.stderr.split("\n").filter((line) => line !== "");
}

describe("scripts/check.sh: what stops make up", () => {
  it("passes quietly on a computer with everything", async () => {
    for (const os of ["linux", "wsl", "macos"] as const) {
      await healthy(os);
      expect(await check(os === "wsl" ? WSL : {})).toEqual({ code: 0, stdout: "", stderr: "" });
    }
  });

  it("stops without docker, with the install step per OS", async () => {
    await healthy("linux");
    await sb.remove("docker");
    expect(failLine(await check())).toBe(
      "Docker is not installed. Install Docker Engine (https://docs.docker.com/engine/install/), then run make up again.",
    );
    await sb.os("macos");
    expect(failLine(await check())).toBe(
      "Docker is not installed. Install OrbStack (https://orbstack.dev) or Docker Desktop, then run make up again.",
    );
  });

  it("on WSL2 without docker, names the distro to turn WSL integration on for", async () => {
    await healthy("wsl");
    await sb.remove("docker");
    expect(failLine(await check(WSL))).toBe(
      "docker is not in this distro. Start Docker Desktop in Windows and turn on Settings > Resources > WSL integration for Ubuntu, then run make up again.",
    );
    // A WSL kernel with no WSL_DISTRO_NAME, as under sudo.
    expect(failLine(await check())).toMatch(/WSL integration for this distro, then/);
  });

  it("stops when the user may not use Docker, with the usermod step", async () => {
    await healthy("linux");
    await docker({
      infoError:
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
    });
    expect(failLine(await check())).toBe(
      "Your user may not use Docker. Run sudo usermod -aG docker $USER, then log out and back in, and run make up again.",
    );
    await sb.os("wsl");
    expect(failLine(await check(WSL))).toBe(
      "Your user may not use Docker. Run sudo usermod -aG docker $USER, then wsl --shutdown in Windows, then open the terminal and run make up again.",
    );
  });

  it("stops when Docker is not running, with the step per OS", async () => {
    await healthy("linux");
    await docker({ infoError: NOT_RUNNING });
    expect(failLine(await check())).toBe(
      "Docker is not running. Run sudo systemctl enable --now docker, then make up again.",
    );
    await sb.os("macos");
    expect(failLine(await check())).toBe(
      "Docker is not running. Open OrbStack or Docker Desktop, then run make up again.",
    );
    await sb.os("wsl");
    expect(failLine(await check(WSL))).toBe(
      "Docker is not running. Start Docker Desktop in Windows, then run make up again.",
    );
  });

  it("stops without Docker Compose v2", async () => {
    await healthy("linux");
    await docker({ compose: null });
    expect(failLine(await check())).toBe(
      "Docker Compose v2 is missing. Install the docker-compose-plugin package (https://docs.docker.com/compose/install/linux/), then run make up again.",
    );
    await docker({ compose: "1.29.2" });
    expect(failLine(await check())).toMatch(/^Docker Compose v2 is missing\./);
    await docker({ compose: "v2.30.3-desktop.1" });
    expect((await check()).code).toBe(0);
  });

  it("refuses Docker Desktop on Linux, running or not, but not on WSL2 or macOS", async () => {
    await healthy("linux");
    await docker({ info: DESKTOP });
    const refusal = `Docker Desktop for Linux is not supported yet: files majhi writes would belong to another user. ${ENGINE_STEP}`;
    expect(failLine(await check())).toBe(refusal);
    await docker({
      infoError:
        "Cannot connect to the Docker daemon at unix:///home/owner/.docker/desktop/docker.sock. Is the docker daemon running?",
    });
    expect(failLine(await check())).toBe(refusal);

    await sb.os("macos");
    await docker({ info: DESKTOP });
    expect((await check()).code).toBe(0);
    await sb.os("wsl");
    expect((await check(WSL)).code).toBe(0);
  });

  it("refuses rootless Docker, and says to unset DOCKER_HOST when it is set", async () => {
    await healthy("linux");
    await docker({ info: ROOTLESS });
    expect(failLine(await check())).toBe(
      `Rootless Docker is not supported yet: files majhi writes would belong to another user. ${ENGINE_STEP}`,
    );
    expect(failLine(await check({ DOCKER_HOST: "unix:///run/user/1000/docker.sock" }))).toBe(
      "Rootless Docker is not supported yet: files majhi writes would belong to another user. Switch to Docker Engine running as root (https://docs.docker.com/engine/install/): unset DOCKER_HOST, sudo systemctl enable --now docker, then docker context use default, then make up again.",
    );
  });

  it("stops on a system that is not macOS, Linux or WSL2", async () => {
    await healthy("linux");
    await sb.fake("uname", "echo MINGW64_NT-10.0-22631");
    expect(failLine(await check())).toBe(
      "majhi runs on macOS, Linux and Windows through WSL2. On Windows, run make up in a WSL2 distro.",
    );
  });
});

describe("scripts/check.sh: what only warns", () => {
  it("warns without git or Node, and off macOS says majhi then has no SSH agent", async () => {
    await healthy("linux");
    await sb.remove("git");
    const noNode = { MAJHI_NODE: join(sb.root, "missing", "node") };
    expect(warnings(await check(noNode))).toEqual([
      "Warning: git is not installed, so majhi cannot update itself. Install git to turn updates on.",
      "Warning: Node 20 or newer is not installed, so the host helper is off: no folder browser, remounts when roots change, updates, start at login, notifications or keyring copy of the secrets key, and majhi has no SSH agent for git. Install Node 20 or newer, then run make up again.",
    ]);
    await sb.os("macos");
    const [, node] = warnings(await check(noNode));
    expect(node).toMatch(/^Warning: Node 20 or newer is not installed, so the host helper is off: /);
    expect(node).not.toMatch(/SSH/);
    // An old Node is no Node.
    await sb.fake("node", "exit 1");
    expect(warnings(await check())).toHaveLength(2);
  });

  it("warns when the secrets key cannot have a keyring copy, and points to the export", async () => {
    await healthy("linux");
    const exportStep =
      "The secrets key has no copy in a keyring: export it on majhi's Health page (Export key) and keep the file safe.";
    await sb.fake("busctl", "echo 'b true'");
    expect(warnings(await check())).toEqual([`Warning: The keyring is locked. ${exportStep}`]);
    await sb.fake("busctl", "echo 'Failed to get property Locked: The name is not activatable' >&2; exit 1");
    expect(warnings(await check())).toEqual([`Warning: No keyring is running. ${exportStep}`]);
    await sb.remove("busctl");
    expect(warnings(await check())).toEqual([
      `Warning: The keyring cannot be checked without busctl (systemd). ${exportStep}`,
    ]);
    await sb.remove("secret-tool");
    expect(warnings(await check())).toEqual([
      `Warning: secret-tool is not installed. Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch). ${exportStep}`,
    ]);
    // The Keychain always holds it on macOS.
    await sb.os("macos");
    expect(warnings(await check())).toEqual([]);
  });

  it("warns without a systemd user manager, with the wsl.conf step on WSL2", async () => {
    await healthy("wsl");
    await sb.fake(
      "systemctl",
      "echo 'System has not been booted with systemd as init system (PID 1).' >&2; exit 1",
    );
    expect(warnings(await check(WSL))).toEqual([
      "Warning: systemd is off in this distro, so the host helper is off: no folder browser, remounts when roots change, updates, start at login, notifications or keyring copy of the secrets key, and majhi has no SSH agent for git. Add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown in Windows, then open the terminal and run make up again.",
    ]);
    await sb.os("linux");
    await docker({ info: ENGINE });
    await sb.remove("systemctl");
    const [line] = warnings(await check());
    expect(line).toMatch(/^Warning: systemd's user manager is not answering \(systemctl --user\)/);
    expect(line).toMatch(/Run make up from your own login session, not through su or sudo\.$/);
  });
});

import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, SCRIPTS_DIR, type ScriptResult, scriptSandbox } from "./testing/scripts.ts";

const REPO = join(SCRIPTS_DIR, "..");
const RUNNING = "host helper: running as majhi-host.service with node v22.11.0. Logs: make host-logs\n";

let sb: Sandbox;
let units: string;
let env: Record<string, string>;

beforeEach(async () => {
  // A home with a space, % and $, which systemd would read as a specifier and a variable.
  sb = await scriptSandbox("owner 100% $HOME");
  // The default folder, in the sandbox's home.
  units = join(sb.home, ".config", "systemd", "user");
  // Node from Volta, so the program on ExecStart is in that home too.
  const node = join(sb.home, ".volta", "bin", "node");
  await mkdir(dirname(node), { recursive: true });
  await writeFile(
    node,
    `#!/bin/sh
case "$1" in
  --version) echo v22.11.0 ;;
  -e) ;;
  *) if [ "\${2:-}" = --ssh-pubkeys ]; then echo "$HOME/.ssh/id_ed25519.pub"; fi ;;
esac
`,
  );
  await chmod(node, 0o755);
  await sb.recorder("docker", `case "$1" in create) echo c0ffee ;; cp) echo '// the helper' >"$3" ;; esac`);
  await sb.recorder("systemctl", `case "$*" in "--user show --property=Version") echo Version=255 ;; esac`);
  await sb.recorder("loginctl", `case "$1" in show-user) echo Linger=no ;; esac`);
  await sb.fake("ssh-agent", "exit 0");
  env = {
    MAJHI_NODE: node,
    MAJHI_PORT: "7171",
    USER: "owner",
    // WSL2 puts the Windows folders on PATH.
    PATH: `${sb.path}:/mnt/c/Program Files/Docker/Docker/resources/bin:/mnt/c/Program Files (x86)/Common Files`,
  };
});
afterEach(() => sb.cleanup());

const host = (command: string, extra: Record<string, string> = {}): Promise<ScriptResult> =>
  sb.run("host.sh", [command], { ...env, ...extra });

describe("scripts/host.sh on Linux and WSL2", () => {
  it("writes both units and the helper's environment the way systemd reads them, then starts them", async () => {
    await sb.os("linux");
    const result = await host("install", {
      DOCKER_CONFIG: '/srv/docker "x" `y` z\\w $HOME',
      DOCKER_CONTEXT: "work\nlaptop",
      MAJHI_SSH_AGENT: join(sb.home, ".majhi", "run", "ssh-agent.sock"),
      MAJHI_LAYA_GPU: "nvidia",
      MAJHI_SECRETS_KEY: join(sb.home, "keys", "majhi.key"),
    });
    expect(result).toEqual({
      code: 0,
      stdout: RUNNING,
      stderr:
        "host helper: left DOCKER_CONTEXT out of the helper's environment: its value has a line break.\n",
    });

    // % is a specifier everywhere in a unit, and $ a variable in a command's arguments.
    const home = `${sb.root}/owner 100%% $HOME`;
    const argHome = `${sb.root}/owner 100%% $$HOME`;
    expect(
      await readFile(join(units, "majhi-host.service"), "utf8"),
    ).toBe(`# Written by make up (scripts/host.sh). make down removes it.
[Unit]
Description=majhi host helper
StartLimitIntervalSec=0

[Service]
ExecStart="${home}/.volta/bin/node" "${argHome}/.majhi/bin/majhi-host.mjs"
EnvironmentFile=${home}/.config/systemd/user/majhi-host.env
Restart=always
RestartSec=2
StandardOutput=append:${home}/.majhi/logs/host.out
StandardError=append:${home}/.majhi/logs/host.out

[Install]
WantedBy=default.target
`);
    expect(
      await readFile(join(units, "majhi-ssh-agent.service"), "utf8"),
    ).toBe(`# Written by make up (scripts/host.sh). make down removes it.
[Unit]
Description=majhi's SSH agent, for when the session has none

[Service]
ExecStartPre="${sb.tools}/mkdir" -p -m 700 "${argHome}/.majhi/run"
ExecStartPre="${sb.tools}/rm" -f "${argHome}/.majhi/run/agent.sock"
ExecStart="${sb.bin}/ssh-agent" -D -a "${argHome}/.majhi/run/agent.sock"
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`);

    // In double quotes, systemd keeps \ " ` and $ when each has a backslash in front.
    const envHome = `${sb.root}/owner 100% \\$HOME`;
    expect(
      await readFile(join(units, "majhi-host.env"), "utf8"),
    ).toBe(`# Written by make up (scripts/host.sh) for majhi-host.service. make down removes it.
MAJHI_URL="http://127.0.0.1:7171"
MAJHI_HOME="${envHome}/.majhi"
MAJHI_REPO="${REPO}"
PATH="${env.PATH}"
HOME="${envHome}"
MAJHI_PORT="7171"
DOCKER_CONFIG="/srv/docker \\"x\\" \\\`y\\\` z\\\\w \\$HOME"
MAJHI_SSH_AGENT="${envHome}/.majhi/run/ssh-agent.sock"
MAJHI_LAYA_GPU="nvidia"
MAJHI_SECRETS_KEY="${envHome}/keys/majhi.key"
`);
    expect((await stat(join(units, "majhi-host.env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(sb.home, ".majhi", "run"))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(sb.home, ".majhi", "bin", "majhi-host.mjs"), "utf8")).toBe("// the helper\n");

    // The agent only starts, so a second make up keeps the keys it holds. The helper restarts.
    expect(await sb.calls("systemctl")).toEqual([
      "--user show --property=Version",
      "--user daemon-reload",
      "--user enable --quiet majhi-ssh-agent.service majhi-host.service",
      "--user start majhi-ssh-agent.service",
      "--user restart majhi-host.service",
    ]);
    expect(await sb.calls("docker")).toEqual([
      "create majhi-server:dev",
      `cp c0ffee:/app/host/majhi-host.mjs ${sb.home}/.majhi/bin/majhi-host.mjs.tmp`,
      "rm c0ffee",
    ]);
    expect(await sb.calls("loginctl")).toEqual([]);
  });

  it("on WSL2 also keeps the user's services running without a login, or says the sudo line", async () => {
    await sb.os("wsl");
    expect(await host("install")).toEqual({ code: 0, stdout: RUNNING, stderr: "" });
    expect(await sb.calls("loginctl")).toEqual([
      "show-user owner --property=Linger",
      "enable-linger --no-ask-password owner",
    ]);

    await sb.recorder("loginctl", `case "$1" in show-user) echo Linger=no ;; enable-linger) exit 1 ;; esac`);
    expect((await host("install")).stdout).toBe(
      `host helper: the helper runs only while a terminal is open in this distro. To start it when Windows starts, run: sudo loginctl enable-linger owner\n${RUNNING}`,
    );

    await sb.clearCalls();
    await sb.recorder("loginctl", `case "$1" in show-user) echo Linger=yes ;; *) exit 1 ;; esac`);
    expect((await host("install")).stdout).toBe(RUNNING);
    expect(await sb.calls("loginctl")).toEqual(["show-user owner --property=Linger"]);
  });

  it("without systemd, says what is off and how to turn it on, and lets make up go on", async () => {
    await sb.os("wsl");
    await sb.recorder(
      "systemctl",
      "echo 'System has not been booted with systemd as init system (PID 1).' >&2; exit 1",
    );
    expect(await host("install")).toEqual({
      code: 0,
      stdout:
        "host helper: systemd is off in this distro, so the host helper is off: no folder browser, remounts when roots change, updates, start at login, notifications or keyring copy of the secrets key, and majhi has no SSH agent for git. Add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown in Windows, then open the terminal and run make up again.\n",
      stderr: "",
    });
    expect(await sb.calls("systemctl")).toEqual(["--user show --property=Version"]);
    expect(await sb.calls("docker")).toEqual([]);
    await expect(readdir(units)).rejects.toThrow();
  });

  it("runs the helper without an agent of its own when ssh-agent is missing", async () => {
    await sb.os("linux");
    await sb.remove("ssh-agent");
    const result = await host("install");
    expect(result.stdout).toBe(
      `host helper: ssh-agent was not found, so majhi has no agent of its own: SSH keys reach it only from the session's agent.\n${RUNNING}`,
    );
    expect((await readdir(units)).sort()).toEqual(["majhi-host.env", "majhi-host.service"]);
    expect(await sb.calls("systemctl")).toEqual([
      "--user show --property=Version",
      "--user daemon-reload",
      "--user enable --quiet majhi-host.service",
      "--user restart majhi-host.service",
    ]);
  });

  it("uninstall stops, disables and removes both units and the environment", async () => {
    await sb.os("linux");
    await host("install");
    // The link systemctl enable makes, which disable cannot take away without a user manager.
    await mkdir(join(units, "default.target.wants"));
    await symlink(
      join(units, "majhi-host.service"),
      join(units, "default.target.wants", "majhi-host.service"),
    );
    await sb.clearCalls();

    expect(await host("uninstall")).toEqual({
      code: 0,
      stdout: "host helper: stopped and removed majhi-host.service majhi-ssh-agent.service\n",
      stderr: "",
    });
    expect(await sb.calls("systemctl")).toEqual([
      "--user disable --now --quiet majhi-host.service",
      "--user disable --now --quiet majhi-ssh-agent.service",
      "--user daemon-reload",
    ]);
    expect(await readdir(units)).toEqual(["default.target.wants"]);
    expect(await readdir(join(units, "default.target.wants"))).toEqual([]);
    // Nothing left to remove.
    expect(await host("uninstall")).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("pubkeys asks the installed helper, and prints nothing before it is installed", async () => {
    await sb.os("linux");
    expect(await host("pubkeys")).toEqual({ code: 0, stdout: "", stderr: "" });
    await host("install");
    expect((await host("pubkeys")).stdout).toBe(`${sb.home}/.ssh/id_ed25519.pub\n`);
  });
});

describe("scripts/host.sh on macOS", () => {
  it("passes the agent socket, Laya's GPU and the secrets key file to the LaunchAgent too", async () => {
    await sb.os("macos");
    await sb.recorder("launchctl");
    const agents = join(sb.root, "LaunchAgents");
    const result = await host("install", {
      MAJHI_LAUNCH_AGENTS_DIR: agents,
      MAJHI_SSH_AGENT: "/run/host-services/ssh-auth.sock",
      MAJHI_LAYA_GPU: "nvidia",
      MAJHI_SECRETS_KEY: "/Users/owner/keys/majhi.key",
    });
    expect(result.stdout).toBe(
      "host helper: running as dev.majhi.host with node v22.11.0. Logs: make host-logs\n",
    );
    const plist = await readFile(join(agents, "dev.majhi.host.plist"), "utf8");
    expect(plist).toContain(
      "    <key>MAJHI_SSH_AGENT</key>\n    <string>/run/host-services/ssh-auth.sock</string>\n",
    );
    expect(plist).toContain("    <key>MAJHI_LAYA_GPU</key>\n    <string>nvidia</string>\n");
    expect(plist).toContain(
      "    <key>MAJHI_SECRETS_KEY</key>\n    <string>/Users/owner/keys/majhi.key</string>\n",
    );
    expect(await sb.calls("systemctl")).toEqual([]);
  });
});

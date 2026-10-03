import { describe, expect, it } from "vitest";
import { failed, fakeOs, ok } from "./platform/fakeOs.ts";
import { createPlatform } from "./platform/index.ts";
import {
  DOCKER_WAIT_MS,
  ensureMajhiRunning,
  MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  type StartupDeps,
  startAtLogin,
} from "./startup.ts";

/** A clock the fake sleep advances, so a two-minute wait takes no time. */
function fakeDeps(script: { dockerUp: boolean[]; opens?: boolean; running?: boolean; startFails?: boolean }) {
  const calls: string[] = [];
  let clock = 0;
  const ups = [...script.dockerUp];
  const deps: StartupDeps = {
    log: (m) => calls.push(`log ${m}`),
    dockerUp: async () => {
      calls.push("docker info");
      return ups.length > 1 ? (ups.shift() ?? false) : (ups[0] ?? false);
    },
    docker: {
      start: async () => {
        calls.push("open docker");
        return script.opens ?? true;
      },
      help: (reason) => `help: ${reason}`,
    },
    majhiRunning: async () => {
      calls.push("ps");
      return script.running ?? false;
    },
    startMajhi: async () => {
      calls.push("compose up");
      if (script.startFails) throw new Error("compose failed\nmore");
    },
    notify: async (m) => {
      calls.push(`notify ${m}`);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls: () => calls.filter((c) => !c.startsWith("log ")), clock: () => clock };
}

describe("ensureMajhiRunning", () => {
  it("does nothing when Docker is up and majhi is running", async () => {
    const f = fakeDeps({ dockerUp: [true], running: true });
    expect(await ensureMajhiRunning(f.deps)).toMatchObject({ ok: true });
    expect(f.calls()).toEqual(["docker info", "ps"]);
  });

  it("starts majhi when Docker is up and the container is not", async () => {
    const f = fakeDeps({ dockerUp: [true] });
    expect(await ensureMajhiRunning(f.deps)).toMatchObject({ ok: true });
    expect(f.calls()).toEqual(["docker info", "ps", "compose up"]);
  });

  it("opens Docker, waits for it, then starts majhi", async () => {
    const f = fakeDeps({ dockerUp: [false, false, false, true] });
    const outcome = await ensureMajhiRunning(f.deps);
    expect(outcome).toMatchObject({ ok: true });
    expect(f.calls()).toEqual([
      "docker info",
      "open docker",
      "docker info",
      "docker info",
      "docker info",
      "ps",
      "compose up",
    ]);
    expect(f.clock()).toBe(15_000);
  });

  it("gives up on Docker after two minutes, polling every few seconds and never in a tight loop", async () => {
    const f = fakeDeps({ dockerUp: [false] });
    const outcome = await ensureMajhiRunning(f.deps);
    expect(outcome).toEqual({ ok: false, step: "wait for Docker", message: "help: slow" });
    expect(f.clock()).toBe(DOCKER_WAIT_MS);
    expect(f.calls().filter((c) => c === "docker info").length).toBe(DOCKER_WAIT_MS / 5_000 + 1);
  });

  it("names the owner's step when nothing could start Docker", async () => {
    const f = fakeDeps({ dockerUp: [false], opens: false });
    expect(await ensureMajhiRunning(f.deps)).toEqual({
      ok: false,
      step: "open Docker",
      message: "help: not-started",
    });
  });

  it("reports one failing step when compose up fails", async () => {
    const f = fakeDeps({ dockerUp: [true], startFails: true });
    expect(await ensureMajhiRunning(f.deps)).toMatchObject({
      ok: false,
      step: "start majhi",
      message: expect.stringContaining("make up"),
    });
  });
});

describe("startAtLogin", () => {
  it("retries a minute apart and notifies once, after the last attempt", async () => {
    const f = fakeDeps({ dockerUp: [true], startFails: true });
    const outcome = await startAtLogin(f.deps);
    expect(outcome.ok).toBe(false);
    expect(f.calls().filter((c) => c === "compose up").length).toBe(MAX_ATTEMPTS);
    expect(f.calls().filter((c) => c.startsWith("notify")).length).toBe(1);
    expect(f.clock()).toBe(RETRY_DELAY_MS * (MAX_ATTEMPTS - 1));
  });

  it("stays quiet when it works, and does not retry", async () => {
    const f = fakeDeps({ dockerUp: [true] });
    await startAtLogin(f.deps);
    expect(f.calls().some((c) => c.startsWith("notify"))).toBe(false);
    expect(f.clock()).toBe(0);
  });
});

describe("Docker per OS", () => {
  /** One pass with each OS's own Docker part, while `docker info` answers `ups` in turn. */
  const pass = (docker: StartupDeps["docker"], ups: boolean[]) =>
    ensureMajhiRunning({ ...fakeDeps({ dockerUp: ups }).deps, docker });

  it("macOS opens OrbStack, and Docker Desktop when OrbStack does not open", async () => {
    const os = fakeOs({
      home: "/Users/owner",
      files: ["/Applications/OrbStack.app", "/Users/owner/Applications/Docker.app"],
      programs: { "/usr/bin/open": (args) => (args[1] === "OrbStack" ? failed() : ok()) },
    });
    expect(await pass(createPlatform("macos", os.deps).docker, [false, true])).toMatchObject({ ok: true });
    expect(os.runs.map((r) => [r.file, ...r.args])).toEqual([
      ["/usr/bin/open", "-a", "OrbStack"],
      ["/usr/bin/open", "-a", "Docker"],
    ]);
    expect(os.logs).toEqual(["startup: could not open OrbStack", "startup: opened Docker"]);
  });

  it("macOS asks for OrbStack or Docker Desktop when neither is there, or when it stays down", async () => {
    const none = fakeOs({ home: "/Users/owner", programs: { "/usr/bin/open": () => ok() } });
    expect(await pass(createPlatform("macos", none.deps).docker, [false])).toEqual({
      ok: false,
      step: "open Docker",
      message: "Install OrbStack or Docker Desktop, open it once, and majhi starts by itself.",
    });
    expect(none.runs).toEqual([]);

    const slow = fakeOs({ files: ["/Applications/OrbStack.app"], programs: { "/usr/bin/open": () => ok() } });
    expect(await pass(createPlatform("macos", slow.deps).docker, [false])).toEqual({
      ok: false,
      step: "wait for Docker",
      message:
        "Docker did not start in 2 minutes. Open OrbStack or Docker Desktop, and majhi starts by itself.",
    });
  });

  it("Linux starts nothing, since Docker Engine needs root, and names the command", async () => {
    const os = fakeOs({ programs: { "/usr/bin/systemctl": () => ok() } });
    expect(await pass(createPlatform("linux", os.deps).docker, [false])).toEqual({
      ok: false,
      step: "open Docker",
      message: "Docker is not running. Run sudo systemctl enable --now docker, and majhi starts by itself.",
    });
    expect(os.runs).toEqual([]);
  });

  it("WSL2 starts Docker Desktop in Windows through powershell.exe", async () => {
    const exe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
    const app = "/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe";
    const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const os = fakeOs({
      env: { WSL_INTEROP: "/run/WSL/12_interop", WSL_DISTRO_NAME: "Ubuntu" },
      path: "/usr/bin:/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0",
      files: [app],
      programs: {
        "/usr/bin/wslpath": (args) => (args[0] === "-u" && args[1] === exe ? ok(`${app}\n`) : failed()),
        [powershell]: () => ok(),
      },
    });
    expect(await pass(createPlatform("wsl", os.deps).docker, [false, true])).toMatchObject({ ok: true });

    const started = os.runs.find((r) => r.file === powershell);
    const encoded = started?.args[started.args.indexOf("-EncodedCommand") + 1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(`Start-Process -FilePath '${exe}'`);
    expect(started?.options.env.WSL_INTEROP).toBe("/run/WSL/12_interop");
  });

  it("WSL2 asks for Docker Desktop with WSL integration when it is not installed", async () => {
    const os = fakeOs({
      programs: { "/usr/bin/wslpath": () => ok("/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe\n") },
    });
    const docker = createPlatform("wsl", os.deps).docker;
    expect(await pass(docker, [false])).toEqual({
      ok: false,
      step: "open Docker",
      message:
        "Open Docker Desktop in Windows with WSL integration on for this distro, and majhi starts by itself.",
    });
    expect(docker.help("slow")).toBe(
      "Docker Desktop did not start in 2 minutes. Open it in Windows, and majhi starts by itself.",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  DOCKER_WAIT_MS,
  ensureMajhiRunning,
  MAX_ATTEMPTS,
  notificationScript,
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
    openDocker: async () => {
      calls.push("open docker");
      return script.opens ?? true;
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
    expect(outcome).toMatchObject({ ok: false, step: "wait for Docker" });
    expect(f.clock()).toBe(DOCKER_WAIT_MS);
    expect(f.calls().filter((c) => c === "docker info").length).toBe(DOCKER_WAIT_MS / 5_000 + 1);
  });

  it("says to install a runtime when neither app exists", async () => {
    const f = fakeDeps({ dockerUp: [false], opens: false });
    expect(await ensureMajhiRunning(f.deps)).toMatchObject({ ok: false, step: "open Docker" });
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

describe("notificationScript", () => {
  it("escapes quotes and backslashes so a message cannot leave its string", () => {
    expect(notificationScript('run "make up" \\ now')).toBe(
      'display notification "run \\"make up\\" \\\\ now" with title "majhi"',
    );
  });
});

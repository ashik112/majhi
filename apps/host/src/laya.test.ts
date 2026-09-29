import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaya, type Proc, type SpawnProc } from "./laya.ts";
import { LAYAD_SOURCE } from "./layadSource.ts";
import type { RunFn } from "./ssh.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "majhi-laya-test-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

/** A process that prints the given lines when started, then exits with `code` unless `stay`. */
function fakeProc(out: string[], code: number | null, stay = false, err: string[] = []): Proc {
  const lines: Array<(s: "out" | "err", l: string) => void> = [];
  const exits: Array<(c: number | null) => void> = [];
  queueMicrotask(() => {
    for (const l of err) for (const f of lines) f("err", l);
    for (const l of out) for (const f of lines) f("out", l);
    if (!stay) for (const f of exits) f(code);
  });
  return { onLine: (l) => void lines.push(l), onExit: (l) => void exits.push(l), kill: () => {} };
}

function setup(
  over: { python?: string; pipFails?: boolean; download?: () => Proc; serve?: () => Proc } = {},
) {
  const runs: string[] = [];
  const run: RunFn = async (file, args) => {
    runs.push(`${file} ${args.join(" ")}`);
    if (args[0] === "-c") {
      const version = over.python ?? "3.13";
      return file.endsWith("python3.13")
        ? { code: 0, stdout: `${version}\n`, stderr: "" }
        : { code: null, stdout: "", stderr: "" };
    }
    if (args.includes("pip") && over.pipFails)
      return { code: 1, stdout: "", stderr: "ERROR: no matching distribution\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const spawned: string[] = [];
  const spawnProc: SpawnProc = (_file, args) => {
    spawned.push(args[1] ?? "");
    if (args[1] === "download") {
      return over.download?.() ?? fakeProc(['{"progress": 0.5}', '{"done": true}'], 0);
    }
    return over.serve?.() ?? fakeProc(['{"ready": true, "port": 4321}'], 0, true);
  };
  const requests: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests.push({
      url,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)),
    });
    return new Response(
      JSON.stringify({
        answers: {
          pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.95, b: 0.05 } },
        },
        loadMs: 0,
        predictMs: 12,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const laya = createLaya({
    majhiHome: home,
    home,
    path: "/usr/bin",
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    run,
    spawnProc,
    fetch: fetchFn,
    log: () => {},
  });
  return { laya, runs, spawned, requests };
}

describe("laya runtime in the host helper", () => {
  it("reports unsupported on hardware that cannot run MLX", () => {
    const laya = createLaya({
      majhiHome: home,
      home,
      path: "",
      platform: "darwin",
      arch: "x64",
      osRelease: "25.0.0",
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      log: () => {},
    });
    expect(laya.status()).toEqual({ state: "unsupported", detail: "Laya needs a Mac with Apple silicon." });
    expect(laya.install().state).toBe("unsupported");
  });

  it("installs into a private venv, downloads the model, then answers questions", async () => {
    const { laya, runs, spawned, requests } = setup();
    expect(laya.install().state).toBe("installing");
    await laya.settled();
    expect(laya.status()).toEqual({ state: "ready", version: "0.2.0" });
    expect(runs.some((r) => r.includes("-m venv") && r.includes("/laya/venv"))).toBe(true);
    expect(runs.some((r) => r.includes("pip install") && r.includes("laya-mlx==0.2.0"))).toBe(true);
    expect(spawned).toEqual(["download"]);
    expect(await readFile(join(home, "laya", "layad.py"), "utf8")).toBe(LAYAD_SOURCE);

    const result = await laya.decide({
      state: "hello",
      questions: { pick: { type: "choice", instructions: "Pick", criteria: ["a", "b"] } },
    });
    expect(result.answers.pick?.choice).toBe("a");
    expect(laya.status().state).toBe("loaded");
    expect(spawned).toEqual(["download", "serve"]);
    expect(requests[0]?.url).toBe("http://127.0.0.1:4321/predict");
    expect(requests[0]?.auth).toMatch(/^Bearer [0-9a-f]{48}$/);
    await laya.decide({ state: "again", questions: { pick: { type: "noul", instructions: "Yes?" } } });
    expect(spawned).toEqual(["download", "serve"]);
    laya.stop();
  });

  it("notices an earlier install after a restart", async () => {
    const first = setup();
    first.laya.install();
    await first.laya.settled();
    const second = setup();
    await second.laya.settled();
    expect(second.laya.status()).toEqual({ state: "ready", version: "0.2.0" });
  });

  it("says plainly when there is no Python 3.11 or newer", async () => {
    const { laya } = setup({ python: "3.9" });
    laya.install();
    await laya.settled();
    expect(laya.status()).toEqual({
      state: "unsupported",
      detail: "Laya needs Python 3.11 or newer, and none was found on this Mac.",
    });
  });

  it("reports a failed pip install and a failed download as errors that can be retried", async () => {
    const pip = setup({ pipFails: true });
    pip.laya.install();
    await pip.laya.settled();
    expect(pip.laya.status().state).toBe("error");
    expect(pip.laya.status().detail).toContain("no matching distribution");

    const download = setup({ download: () => fakeProc([], 1, false, ["network is down"]) });
    download.laya.install();
    await download.laya.settled();
    expect(download.laya.status()).toEqual({
      state: "error",
      detail: "The model download failed: network is down",
    });
    expect(download.laya.install().state).toBe("installing");
  });

  it("refuses to decide before the install is done", async () => {
    const { laya } = setup();
    await expect(laya.decide({ state: "x", questions: {} })).rejects.toThrow("Laya is not installed");
  });
});

describe("the embedded Python service", () => {
  it("matches py/layad.py", async () => {
    const py = await readFile(new URL("../py/layad.py", import.meta.url), "utf8");
    expect(LAYAD_SOURCE).toBe(py);
  });
});

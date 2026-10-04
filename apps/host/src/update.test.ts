import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type UpdateStatus, UpdateStatusSchema } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUARD_CONFIG } from "./gitGuard.ts";
import type { ExecFn } from "./remount.ts";
import { createUpdater } from "./update.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

describe("update", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-update-"));
    await mkdir(join(dir, "repo"));
    await mkdir(join(dir, "home"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  function setup(options: {
    failOn?: string;
    /** Fails only the first command that starts with this. */
    failOnce?: string;
    /** Fails the build this many times with a network error first. */
    netFails?: number;
    dirty?: boolean;
    selfIsBundle?: boolean;
    keyExists?: boolean;
    noImage?: boolean;
    /** The key the Keychain holds. */
    savedKey?: string;
    /** The helper's environment, as `make up` wrote it. */
    env?: NodeJS.ProcessEnv;
    /** Whether the majhi-laya container exists. */
    layaContainer?: boolean;
  }) {
    const calls: Array<{ file: string; args: string; env: NodeJS.ProcessEnv }> = [];
    const exit: string[] = [];
    const ensured: string[] = [];
    let failedOnce = false;
    let netFailed = 0;
    const exec: ExecFn = async (file, args, opts) => {
      const line = args.join(" ");
      calls.push({ file, args: line, env: opts.env });
      if (options.failOn !== undefined && line.startsWith(options.failOn)) {
        throw Object.assign(new Error("Command failed"), { stderr: "boom: no space left" });
      }
      if (line.startsWith("compose --profile runner") && netFailed < (options.netFails ?? 0)) {
        netFailed += 1;
        throw Object.assign(new Error("Command failed"), {
          stderr:
            'failed to fetch oauth token: Post "https://auth.docker.io/token": net/http: TLS handshake timeout',
        });
      }
      if (options.failOnce !== undefined && line.startsWith(options.failOnce) && !failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error("Command failed"), { stderr: "container majhi-server-1 is unhealthy" });
      }
      if (line.startsWith("image inspect")) {
        if (options.noImage) throw Object.assign(new Error("Command failed"), { stderr: "No such image" });
        return { stdout: line.endsWith("majhi-laya:dev") ? "sha256:oldlaya\n" : "sha256:old\n", stderr: "" };
      }
      if (line.startsWith("container inspect")) {
        if (!options.layaContainer)
          throw Object.assign(new Error("Command failed"), { stderr: "No such container" });
        return { stdout: "cid-laya\n", stderr: "" };
      }
      if (line.startsWith("compose logs")) {
        return { stdout: "server-1  | starting\nserver-1  | SqliteError: malformed JSON\n", stderr: "" };
      }
      if (file === "/usr/bin/git") {
        const command = args.slice(GUARD_CONFIG.length)[0];
        return {
          stdout:
            command === "rev-parse" ? `${HEAD}\n` : command === "status" && options.dirty ? " M a\n" : "",
          stderr: "",
        };
      }
      if (line.startsWith("compose run")) return { stdout: "services: {}\n", stderr: "" };
      if (line.startsWith("run --rm")) return { stdout: "AGE-SECRET-KEY-TEST\n", stderr: "" };
      if (line.startsWith("create")) return { stdout: "cid123\n", stderr: "" };
      if (line.startsWith("cp")) {
        await writeFile(args[2] ?? "", "bundle");
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const bundle = join(dir, "home", "bin", "majhi-host.mjs");
    const key = join(dir, "secrets", "secrets.key");
    const run = async () => {
      if (options.keyExists) {
        await mkdir(join(dir, "secrets"));
        await writeFile(key, "existing");
      }
      const start = createUpdater({
        remount: {
          repo: join(dir, "repo"),
          docker: "/usr/bin/docker",
          env: { HOME: "/h", ...options.env },
          exec,
          log: () => undefined,
        },
        git: { git: "/usr/bin/git", repo: join(dir, "repo"), env: {}, exec },
        majhiHome: join(dir, "home"),
        bundle,
        selfPath: options.selfIsBundle ? bundle : "/elsewhere/main.ts",
        secretsKeyFile: key,
        keyBackup: {
          where: "the Keychain",
          read: async () => options.savedKey,
          ensure: async () => {
            ensured.push("ensure");
            return undefined;
          },
        },
        log: () => undefined,
        exit: () => exit.push("exit"),
        sleep: async () => undefined,
      });
      expect(start()).toBe(true);
      // Wait for the background run to end.
      for (let i = 0; i < 200; i += 1) {
        const status = await readStatus();
        if (status && status.state !== "running") return status;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("update did not finish");
    };
    const readStatus = async (): Promise<UpdateStatus | undefined> => {
      try {
        return UpdateStatusSchema.parse(JSON.parse(await readFile(join(dir, "home", "update.json"), "utf8")));
      } catch {
        return undefined;
      }
    };
    return { calls, exit, run, bundle, key, ensured };
  }

  it("builds with the commit baked in, regenerates the mounts, starts, and replaces the helper last", async () => {
    const s = setup({ selfIsBundle: true, dirty: true });
    const status = await s.run();
    expect(status.state).toBe("done");
    expect(status.commit).toBe(HEAD);
    expect(status.lines.join("\n")).toContain("changes you have not committed");

    const docker = s.calls.filter((c) => c.file === "/usr/bin/docker").map((c) => c.args);
    const order = [
      "compose --profile runner build",
      "run --rm",
      "compose run",
      "compose up -d --wait",
      "create",
      "cp",
    ];
    const at = order.map((prefix) => docker.findIndex((a) => a.startsWith(prefix)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(s.calls.find((c) => c.args === "compose --profile runner build")?.env.MAJHI_COMMIT).toBe(HEAD);
    expect(await readFile(s.bundle, "utf8")).toBe("bundle");
    expect(await readFile(s.key, "utf8")).toBe("AGE-SECRET-KEY-TEST\n");
    expect(s.ensured).toEqual(["ensure"]);
    expect(s.exit).toEqual(["exit"]);
  });

  it("removes the images and build cache it replaced once the new majhi runs, and a failed clean-up fails nothing", async () => {
    const s = setup({ selfIsBundle: true });
    expect((await s.run()).state).toBe("done");
    const docker = s.calls.filter((c) => c.file === "/usr/bin/docker").map((c) => c.args);
    const up = docker.findIndex((a) => a.startsWith("compose up -d --wait"));
    const prune = docker.indexOf("image prune -f");
    expect(prune).toBeGreaterThan(up);
    expect(docker).toContain("builder prune -f --max-used-space 3gb");
    // Never volumes, never everything: only dangling images and old cache.
    expect(docker.some((a) => a.includes("volume") || a.includes("system prune") || a.includes("-a"))).toBe(
      false,
    );
  });

  it("finishes the update when the clean-up fails, trying the older Docker flag first", async () => {
    const s = setup({ selfIsBundle: true, failOn: "builder prune" });
    expect((await s.run()).state).toBe("done");
    expect(s.calls.map((c) => c.args)).toContain("builder prune -f --keep-storage 3gb");
  });

  it("cleans nothing when the build fails: the previous image may be needed to go back", async () => {
    const s = setup({ failOn: "compose --profile runner build" });
    expect((await s.run()).state).toBe("failed");
    expect(s.calls.some((c) => c.args.includes("prune"))).toBe(false);
  });

  it("puts back the key the Keychain holds instead of making a new one", async () => {
    const s = setup({ savedKey: "AGE-SECRET-KEY-1SAVED" });
    const status = await s.run();
    expect(status.state).toBe("done");
    expect(s.calls.some((c) => c.args.startsWith("run --rm"))).toBe(false);
    expect(await readFile(s.key, "utf8")).toBe("AGE-SECRET-KEY-1SAVED\n");
    expect(status.lines).toContain("Putting back the secrets key from the Keychain");
  });

  it("keeps an existing secrets key and does not exit when it is not running from the installed bundle", async () => {
    const s = setup({ keyExists: true });
    const status = await s.run();
    expect(status.state).toBe("done");
    expect(s.calls.some((c) => c.args.startsWith("run --rm"))).toBe(false);
    expect(await readFile(s.key, "utf8")).toBe("existing");
    expect(s.exit).toEqual([]);
  });

  it("fails with the reason, leaves the running majhi alone and does not replace the helper", async () => {
    const s = setup({ failOn: "compose --profile runner build", selfIsBundle: true });
    const status = await s.run();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("build failed");
    expect(status.error).toContain("no space left");
    expect(s.calls.some((c) => c.args.startsWith("compose up"))).toBe(false);
    expect(s.exit).toEqual([]);
  });

  it("goes back to the previous image and mounts when the new majhi does not start, with the reason", async () => {
    const s = setup({ failOnce: "compose up", selfIsBundle: true });
    await writeFile(join(dir, "repo", "docker-compose.override.yml"), "old mounts\n");
    const status = await s.run();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("SqliteError: malformed JSON");
    expect(status.lines).toContain("The new majhi said: SqliteError: malformed JSON");
    expect(status.lines.join("\n")).toContain("Went back to the previous version");
    const docker = s.calls.filter((c) => c.file === "/usr/bin/docker").map((c) => c.args);
    const tagBack = docker.indexOf("tag sha256:old majhi-server:dev");
    const firstUp = docker.indexOf("compose up -d --wait");
    expect(tagBack).toBeGreaterThan(firstUp);
    expect(docker.lastIndexOf("compose up -d --wait")).toBeGreaterThan(tagBack);
    expect(await readFile(join(dir, "repo", "docker-compose.override.yml"), "utf8")).toBe("old mounts\n");
    expect(s.calls.some((c) => c.args.startsWith("create"))).toBe(false);
    expect(s.exit).toEqual([]);
  });

  it("keeps the previous image tagged so a prune cannot remove it", async () => {
    const s = setup({});
    await s.run();
    const docker = s.calls.filter((c) => c.file === "/usr/bin/docker").map((c) => c.args);
    const tagged = docker.indexOf("tag sha256:old majhi-server:previous");
    expect(tagged).toBeGreaterThanOrEqual(0);
    expect(tagged).toBeLessThan(docker.indexOf("compose --profile runner build"));
  });

  it("says so when there was no previous image to go back to", async () => {
    const s = setup({ failOnce: "compose up", noImage: true });
    const status = await s.run();
    expect(status.state).toBe("failed");
    expect(status.lines.join("\n")).toContain("No previous version to go back to");
    expect(s.calls.some((c) => c.args.startsWith("tag "))).toBe(false);
  });

  it("tries the build again when Docker Hub does not answer, and goes on when it does", async () => {
    const s = setup({ netFails: 2 });
    const status = await s.run();
    expect(status.state).toBe("done");
    expect(s.calls.filter((c) => c.args === "compose --profile runner build")).toHaveLength(3);
    expect(status.lines.join("\n")).toContain("Docker Hub did not answer. Trying again");
  });

  it("gives up after three network failures with a plain reason, and leaves majhi running", async () => {
    const s = setup({ netFails: 5 });
    const status = await s.run();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("Docker Hub could not be reached after 3 tries");
    expect(s.calls.filter((c) => c.args === "compose --profile runner build")).toHaveLength(3);
    expect(s.calls.some((c) => c.args.startsWith("compose up"))).toBe(false);
  });

  it("does not retry a build that failed for another reason", async () => {
    const s = setup({ failOn: "compose --profile runner build" });
    await s.run();
    expect(s.calls.filter((c) => c.args === "compose --profile runner build")).toHaveLength(1);
  });

  describe("Laya", () => {
    const docker = (s: { calls: Array<{ file: string; args: string }> }) =>
      s.calls.filter((c) => c.file === "/usr/bin/docker").map((c) => c.args);
    const env = (s: { calls: Array<{ args: string; env: NodeJS.ProcessEnv }> }, prefix: string) =>
      s.calls.find((c) => c.args.startsWith(prefix))?.env;

    it("in Docker on the CPU: builds and restarts Laya, and keeps its previous image", async () => {
      const s = setup({ env: { MAJHI_LAYA: "docker" } });
      expect((await s.run()).state).toBe("done");
      const calls = docker(s);
      const build = calls.indexOf("compose --profile runner --profile laya build");
      expect(build).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("tag sha256:oldlaya majhi-laya:previous")).toBeLessThan(build);
      expect(calls.indexOf("tag sha256:oldlaya majhi-laya:previous")).toBeGreaterThanOrEqual(0);
      for (const step of ["compose --profile runner", "compose run", "compose up -d --wait"]) {
        expect(env(s, step)?.COMPOSE_PROFILES).toBe("laya");
      }
      expect(env(s, "compose --profile runner")?.MAJHI_LAYA_DEVICE).toBeUndefined();
      expect(env(s, "compose --profile runner")?.MAJHI_LAYA_TORCH_INDEX).toBeUndefined();
      expect(calls.some((c) => c.startsWith("container inspect"))).toBe(false);
    });

    it("in Docker with NVIDIA: builds Laya with the CUDA args make up recorded", async () => {
      const s = setup({
        env: {
          MAJHI_LAYA: "docker",
          MAJHI_LAYA_GPU: "nvidia",
          MAJHI_LAYA_TORCH_INDEX: "https://download.pytorch.org/whl/cu126",
          MAJHI_LAYA_DEVICE: "cuda",
          COMPOSE_PROFILES: "extra",
        },
      });
      expect((await s.run()).state).toBe("done");
      const build = env(s, "compose --profile runner --profile laya build");
      expect(build?.MAJHI_LAYA_TORCH_INDEX).toBe("https://download.pytorch.org/whl/cu126");
      expect(build?.MAJHI_LAYA_DEVICE).toBe("cuda");
      expect(build?.COMPOSE_PROFILES).toBe("extra,laya");
      expect(env(s, "compose up -d --wait")?.MAJHI_LAYA_GPU).toBe("nvidia");
    });

    it.each(["native", "off"])(
      "%s: builds and keeps no Laya image, even when its old container is there",
      async (mode) => {
        const s = setup({ env: { MAJHI_LAYA: mode }, layaContainer: true });
        expect((await s.run()).state).toBe("done");
        const calls = docker(s);
        expect(calls).toContain("compose --profile runner build");
        expect(calls.some((c) => c.includes("laya"))).toBe(false);
        expect(calls.some((c) => c.startsWith("container inspect"))).toBe(false);
        expect(s.calls.some((c) => c.env.COMPOSE_PROFILES !== undefined)).toBe(false);
      },
    );

    it("without make up's record, builds Laya when its container is there", async () => {
      const s = setup({ layaContainer: true });
      expect((await s.run()).state).toBe("done");
      expect(docker(s)).toContain("compose --profile runner --profile laya build");
      expect(env(s, "compose up -d --wait")?.COMPOSE_PROFILES).toBe("laya");
    });

    it("without make up's record, takes CUDA from the GPU and the Makefile's default index", async () => {
      const s = setup({ env: { MAJHI_LAYA_GPU: "nvidia" } });
      expect((await s.run()).state).toBe("done");
      const build = env(s, "compose --profile runner --profile laya build");
      expect(build?.MAJHI_LAYA_DEVICE).toBe("cuda");
      expect(build?.MAJHI_LAYA_TORCH_INDEX).toBe("https://download.pytorch.org/whl/cu130");
    });

    it("without make up's record, leaves the torch index to .env when it names one", async () => {
      await writeFile(
        join(dir, "repo", ".env"),
        "MAJHI_LAYA_TORCH_INDEX=https://download.pytorch.org/whl/cu126\n",
      );
      const s = setup({ env: { MAJHI_LAYA_GPU: "nvidia" } });
      expect((await s.run()).state).toBe("done");
      const build = env(s, "compose --profile runner --profile laya build");
      expect(build?.MAJHI_LAYA_DEVICE).toBe("cuda");
      expect(build?.MAJHI_LAYA_TORCH_INDEX).toBeUndefined();
    });

    it("goes back to the previous Laya image too when the new majhi does not start", async () => {
      const s = setup({ env: { MAJHI_LAYA: "docker" }, failOnce: "compose up" });
      expect((await s.run()).state).toBe("failed");
      const calls = docker(s);
      const firstUp = calls.indexOf("compose up -d --wait");
      const back = calls.indexOf("tag sha256:oldlaya majhi-laya:dev");
      expect(back).toBeGreaterThan(firstUp);
      expect(calls.indexOf("tag sha256:old majhi-server:dev")).toBeGreaterThan(firstUp);
      expect(calls.lastIndexOf("compose up -d --wait")).toBeGreaterThan(back);
      expect(s.calls.filter((c) => c.args === "compose up -d --wait").at(-1)?.env.COMPOSE_PROFILES).toBe(
        "laya",
      );
    });
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type UpdateStatus, UpdateStatusSchema } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  }) {
    const calls: Array<{ file: string; args: string; env: NodeJS.ProcessEnv }> = [];
    const exit: string[] = [];
    let failedOnce = false;
    let netFailed = 0;
    const exec: ExecFn = async (file, args, opts) => {
      const line = args.join(" ");
      calls.push({ file, args: line, env: opts.env });
      if (options.failOn !== undefined && line.startsWith(options.failOn)) {
        throw Object.assign(new Error("Command failed"), { stderr: "boom: no space left" });
      }
      if (line.startsWith("compose --profile runner build") && netFailed < (options.netFails ?? 0)) {
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
        return { stdout: "sha256:old\n", stderr: "" };
      }
      if (line.startsWith("compose logs")) {
        return { stdout: "server-1  | starting\nserver-1  | SqliteError: malformed JSON\n", stderr: "" };
      }
      if (file === "/usr/bin/git") {
        return {
          stdout: line.startsWith("rev-parse") ? `${HEAD}\n` : options.dirty ? " M a\n" : "",
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
          env: { HOME: "/h" },
          exec,
          log: () => undefined,
        },
        git: { git: "/usr/bin/git", repo: join(dir, "repo"), env: {}, exec },
        majhiHome: join(dir, "home"),
        bundle,
        selfPath: options.selfIsBundle ? bundle : "/elsewhere/main.ts",
        secretsKeyFile: key,
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
    return { calls, exit, run, bundle, key };
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
    expect(s.exit).toEqual(["exit"]);
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
});

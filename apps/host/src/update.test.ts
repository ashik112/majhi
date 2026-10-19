import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type UpdateStatus, UpdateStatusSchema } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUARD_CONFIG } from "./gitGuard.ts";
import type { ExecFn } from "./remount.ts";
import { createUpdater } from "./update.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEWER = "89abcdef0123456789abcdef0123456789abcdef";

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
    /** The release the latest-release pointer names. A tag other than v1.0.0 is at NEWER, on the remote only. */
    latestTag?: string;
    /** The pointer cannot be read. */
    latestFails?: boolean;
  }) {
    const calls: Array<{ file: string; args: string; env: NodeJS.ProcessEnv }> = [];
    const exit: string[] = [];
    const ensured: string[] = [];
    let failedOnce = false;
    let netFailed = 0;
    let head = HEAD;
    let fetched = false;
    const latestAsked: string[] = [];
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
        return {
          stdout: line.endsWith("majhi-laya:dev")
            ? "sha256:oldlaya\n"
            : line.endsWith("majhi-runner:dev")
              ? "sha256:oldrunner\n"
              : "sha256:old\n",
          stderr: "",
        };
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
        const rest = args.slice(GUARD_CONFIG.length);
        const command = rest[0];
        if (options.failOn !== undefined && rest.join(" ").startsWith(options.failOn)) {
          throw Object.assign(new Error("Command failed"), { stderr: "fatal: unable to access" });
        }
        if (command === "fetch") fetched = true;
        if (rest.includes("checkout")) head = rest.at(-1) === `refs/tags/${options.latestTag}` ? NEWER : HEAD;
        const tag = rest.find((a) => a.startsWith("refs/tags/"));
        if (command === "rev-parse" && tag !== undefined) {
          // The installed release's tag is here; a newer one only once fetched.
          if (tag.startsWith("refs/tags/v1.0.0^")) return { stdout: `${HEAD}\n`, stderr: "" };
          if (!fetched) throw Object.assign(new Error("Command failed"), { stderr: "" });
          return { stdout: `${NEWER}\n`, stderr: "" };
        }
        return {
          stdout:
            command === "rev-parse" ? `${head}\n` : command === "status" && options.dirty ? " M a\n" : "",
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
      const start = createUpdater(makeOptions());
      expect(start()).toBe(true);
      for (;;) {
        const status = await readStatus();
        if (status && status.state !== "running") return status;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const makeOptions = () => ({
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
      latest: async (url: string) => {
        latestAsked.push(url);
        if (options.latestFails) throw new Error(`${url} answered 503`);
        return options.latestTag ?? "v1.0.0";
      },
    });
    const readStatus = async (): Promise<UpdateStatus | undefined> => {
      try {
        return UpdateStatusSchema.parse(JSON.parse(await readFile(join(dir, "home", "update.json"), "utf8")));
      } catch {
        return undefined;
      }
    };
    return { calls, exit, run, bundle, key, ensured, latestAsked, makeOptions };
  }

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
});

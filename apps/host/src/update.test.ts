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
        latest: async (url) => {
          latestAsked.push(url);
          if (options.latestFails) throw new Error(`${url} answered 503`);
          return options.latestTag ?? "v1.0.0";
        },
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
    return { calls, exit, run, bundle, key, ensured, latestAsked };
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

  it("tries the build again when the registry does not answer, and goes on when it does", async () => {
    const s = setup({ netFails: 2 });
    const status = await s.run();
    expect(status.state).toBe("done");
    expect(s.calls.filter((c) => c.args === "compose --profile runner build")).toHaveLength(3);
    expect(status.lines.join("\n")).toContain("The image registry did not answer. Trying again");
  });

  it("gives up after three network failures with a plain reason, and leaves majhi running", async () => {
    const s = setup({ netFails: 5 });
    const status = await s.run();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("the image registry could not be reached after 3 tries");
    expect(s.calls.filter((c) => c.args === "compose --profile runner build")).toHaveLength(3);
    expect(s.calls.some((c) => c.args.startsWith("compose up"))).toBe(false);
  });

  describe("on a release install", () => {
    const LATEST = "https://api.github.example/repos/acme/majhi/releases/latest";
    const dotenv = `MAJHI_PORT=7071\nMAJHI_VERSION=v1.0.0\nMAJHI_LATEST_URL=${LATEST}\n`;
    const env = () => readFile(join(dir, "repo", ".env"), "utf8");
    const git = (s: { calls: Array<{ file: string; args: string }> }) =>
      s.calls.filter((c) => c.file === "/usr/bin/git").map((c) => c.args);
    beforeEach(() => writeFile(join(dir, "repo", ".env"), dotenv));

    it("moves the checkout and .env to the release the pointer names before the build, which bakes its commit in", async () => {
      const s = setup({ latestTag: "v1.1.0" });
      const status = await s.run();
      expect(status.state).toBe("done");
      expect(s.latestAsked).toEqual([LATEST]);
      expect(status.commit).toBe(NEWER);
      expect(status.lines).toContain("Getting the majhi v1.1.0 images");
      expect(await env()).toBe(`MAJHI_PORT=7071\nMAJHI_LATEST_URL=${LATEST}\nMAJHI_VERSION=v1.1.0\n`);
      const fetchedAt = s.calls.findIndex((c) => c.args.includes("fetch --quiet --tags"));
      const checkout = s.calls.findIndex((c) =>
        c.args.includes("checkout --quiet --detach refs/tags/v1.1.0"),
      );
      const build = s.calls.findIndex((c) => c.args === "compose --profile runner build");
      expect(fetchedAt).toBeGreaterThanOrEqual(0);
      expect(checkout).toBeGreaterThan(fetchedAt);
      expect(build).toBeGreaterThan(checkout);
      expect(s.calls[build]?.env.MAJHI_COMMIT).toBe(NEWER);
      // The release before's images go once the new one runs.
      expect(s.calls.some((c) => c.args.startsWith("image ls --filter label=majhi.release"))).toBe(true);
    });

    it("puts the checkout back when the release images cannot be had, and leaves majhi running", async () => {
      const s = setup({ latestTag: "v1.1.0", failOn: "compose --profile runner build" });
      const status = await s.run();
      expect(status.state).toBe("failed");
      expect(status.lines).toContain("Back on majhi v1.0.0");
      expect(await env()).toBe(dotenv);
      expect(git(s).at(-1)).toContain(`checkout --quiet --detach ${HEAD}`);
      expect(s.calls.some((c) => c.args.startsWith("compose up"))).toBe(false);
    });

    it("puts the checkout back before it starts the previous majhi when the new one does not start", async () => {
      const s = setup({ latestTag: "v1.1.0", failOnce: "compose up" });
      const status = await s.run();
      expect(status.state).toBe("failed");
      expect(status.lines.join("\n")).toContain("Went back to the previous version");
      expect(await env()).toBe(dotenv);
      const back = s.calls.findIndex((c) => c.args.endsWith(`checkout --quiet --detach ${HEAD}`));
      const lastUp = s.calls.map((c) => c.args).lastIndexOf("compose up -d --wait");
      expect(back).toBeGreaterThanOrEqual(0);
      expect(lastUp).toBeGreaterThan(back);
    });

    it("rebuilds the release it runs when the pointer names it, without fetching", async () => {
      const s = setup({ latestTag: "v1.0.0" });
      expect((await s.run()).state).toBe("done");
      expect(git(s).some((a) => a.includes("checkout") || a.includes("fetch"))).toBe(false);
      expect(await env()).toBe(dotenv);
    });

    it("fails without touching anything when the pointer cannot be read", async () => {
      const s = setup({ latestTag: "v1.1.0", latestFails: true });
      const status = await s.run();
      expect(status.state).toBe("failed");
      expect(status.error).toContain("answered 503");
      expect(s.calls.some((c) => c.file === "/usr/bin/docker" && c.args.includes("build"))).toBe(false);
      expect(git(s).some((a) => a.includes("checkout"))).toBe(false);
      expect(await env()).toBe(dotenv);
    });

    it("fails without touching anything when the release's tag cannot be fetched", async () => {
      const s = setup({ latestTag: "v1.1.0", failOn: "fetch" });
      const status = await s.run();
      expect(status.state).toBe("failed");
      expect(s.calls.some((c) => c.file === "/usr/bin/docker" && c.args.includes("build"))).toBe(false);
      expect(await env()).toBe(dotenv);
    });
  });

  it("never asks the pointer or fetches on a dev checkout", async () => {
    const s = setup({ latestTag: "v1.1.0" });
    expect((await s.run()).state).toBe("done");
    expect(s.latestAsked).toEqual([]);
    expect(s.calls.some((c) => c.args.includes("fetch"))).toBe(false);
  });

  it("does not retry a build that failed for another reason", async () => {
    const s = setup({ failOn: "compose --profile runner build" });
    await s.run();
    expect(s.calls.filter((c) => c.args === "compose --profile runner build")).toHaveLength(1);
  });
});

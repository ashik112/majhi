import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTargetReader, moveBack, moveToLatest } from "./release.ts";
import { RUNTIME_FILES, readPackage } from "./releasePackage.ts";
import { type GitContext, readRepo } from "./repoInfo.ts";
import { createUpdater } from "./update.ts";

const exec = promisify(execFile);
const ROOT = resolve(".");
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

describe("runtime package installation and updates", () => {
  let dir: string;
  let app: string;
  let base: string;
  let close: () => Promise<void>;
  const env = () => ({ ...process.env, HOME: dir, MAJHI_INSTALL_ONLY: "1", MAJHI_APP_DIR: app });
  const install = (version = "v1.0.0") =>
    exec("/bin/sh", [join(ROOT, "install.sh")], {
      env: { ...env(), MAJHI_VERSION: version, MAJHI_DOWNLOAD_URL: base, MAJHI_LATEST_URL: `${base}/latest` },
    });
  const ctx = (): GitContext => ({ git: "/no-git", repo: app, env: env(), exec });
  const assets = (version: string) => join(dir, "assets", version);
  const corruptArchive = async (
    change: (stage: string) => Promise<void>,
    names: readonly string[] = RUNTIME_FILES,
  ) => {
    const stage = join(dir, "unpacked");
    await mkdir(stage);
    await exec("tar", ["-xzf", join(assets("v1.1.0"), "majhi-runtime.tar.gz"), "-C", stage]);
    await change(stage);
    await exec("tar", ["-czf", join(assets("v1.1.0"), "majhi-runtime.tar.gz"), "-C", stage, ...names], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const data = await readFile(join(assets("v1.1.0"), "majhi-runtime.tar.gz"));
    await writeFile(
      join(assets("v1.1.0"), "majhi-runtime.tar.gz.sha256"),
      `${createHash("sha256").update(data).digest("hex")}  majhi-runtime.tar.gz\n`,
    );
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-runtime-"));
    app = join(dir, "app");
    for (const [version, commit] of [
      ["v1.0.0", OLD],
      ["v1.1.0", NEW],
    ]) {
      await exec("/bin/sh", [
        join(ROOT, "scripts/package-release.sh"),
        version ?? "",
        commit ?? "",
        assets(version ?? ""),
      ]);
    }
    const server = createServer((req, res) => {
      if (req.url === "/latest") {
        res.end(JSON.stringify({ tag_name: "v1.1.0" }));
        return;
      }
      const match = /^\/(v\d+\.\d+\.\d+)\/(majhi-runtime\.tar\.gz(?:\.sha256)?|release\.json)$/.exec(
        req.url ?? "",
      );
      if (!match) {
        res.writeHead(404).end();
        return;
      }
      void readFile(join(assets(match[1] ?? ""), match[2] ?? "")).then(
        (data) => res.end(data),
        () => res.writeHead(404).end(),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });

  it("installs only runtime files, updates and preserves owner config without git", async () => {
    await install();
    expect(await readPackage(app)).toEqual({ version: "v1.0.0", commit: OLD });
    expect(await readdir(app)).not.toContain(".git");
    expect(await readdir(app)).not.toContain("apps");
    expect(await readFile(join(app, "Dockerfile"), "utf8")).not.toContain("COPY apps");
    await writeFile(
      join(app, ".env"),
      `MAJHI_PORT=7071\nMAJHI_VERSION=v1.0.0\nMAJHI_LATEST_URL=${base}/latest\nMAJHI_DOWNLOAD_URL=${base}\n`,
    );
    await writeFile(join(app, "docker-compose.override.yml"), "owner mounts");
    const target = createTargetReader(ctx());
    expect(await target()).toEqual({ commit: NEW, dirty: false });
    expect(await readRepo(ctx())).toEqual({ commit: OLD, dirty: false });
    const moved = await moveToLatest(ctx(), OLD, async () => undefined);
    expect(await readPackage(app)).toEqual({ version: "v1.1.0", commit: NEW });
    expect(await readFile(join(app, ".env"), "utf8")).toContain("MAJHI_PORT=7071");
    expect(await readFile(join(app, "docker-compose.override.yml"), "utf8")).toBe("owner mounts");
    if (!moved) throw new Error("not moved");
    await moveBack(ctx(), moved);
    expect(await readPackage(app)).toEqual({ version: "v1.0.0", commit: OLD });
    expect(await readFile(join(app, ".env"), "utf8")).toContain("MAJHI_VERSION=v1.0.0");
    await install("v1.1.0");
    expect(await readPackage(app)).toEqual({ version: "v1.1.0", commit: NEW });
  });

  it("runs startup from the package and restores it when startup fails", async () => {
    // Stub host services as well as Docker: this test never changes the real login service.
    const bin = join(dir, "bin");
    await mkdir(bin);
    const calls = join(dir, "docker-calls");
    await writeFile(
      join(bin, "uname"),
      '#!/bin/sh\ncase "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac\n',
      { mode: 0o755 },
    );
    await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(join(bin, "busctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >>"$MAJHI_TEST_CALLS"
case "$*" in
  "info "*) echo '"Linux" []' ;;
  "compose version --short") echo 5.1.2 ;;
  "compose run "*) echo 'services: {}' ;;
  "compose up "*) [ "$MAJHI_TEST_FAIL" != 1 ] ;;
esac
`,
      { mode: 0o755 },
    );
    const key = join(dir, "key");
    await writeFile(key, "existing key");
    const run = (version: string, fail: string) =>
      exec("/bin/sh", [join(ROOT, "install.sh")], {
        env: {
          ...env(),
          PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          MAJHI_VERSION: version,
          MAJHI_DOWNLOAD_URL: base,
          MAJHI_LATEST_URL: `${base}/latest`,
          MAJHI_INSTALL_ONLY: "0",
          MAJHI_SECRETS_KEY: key,
          MAJHI_TEST_CALLS: calls,
          MAJHI_TEST_FAIL: fail,
          LAYA: "off",
        },
      });
    await run("v1.0.0", "0");
    expect((await readPackage(app))?.commit).toBe(OLD);
    await expect(run("v1.1.0", "1")).rejects.toThrow("previous package was restored");
    expect((await readPackage(app))?.commit).toBe(OLD);
    expect(await readFile(join(app, ".env"), "utf8")).toContain("MAJHI_VERSION=v1.0.0");
    expect(await readFile(calls, "utf8")).toContain("compose --profile runner build");
  });

  it("rejects a checksum mismatch before changing the installed package", async () => {
    await install();
    await writeFile(
      join(assets("v1.1.0"), "majhi-runtime.tar.gz.sha256"),
      `${"0".repeat(64)}  majhi-runtime.tar.gz\n`,
    );
    await expect(install("v1.1.0")).rejects.toThrow("failed its checksum");
    expect((await readPackage(app))?.commit).toBe(OLD);
  });

  it("rejects additional archive files even with a matching checksum", async () => {
    await install();
    await corruptArchive(
      (stage) => writeFile(join(stage, "source.ts"), "source"),
      [...RUNTIME_FILES, "source.ts"],
    );
    await expect(install("v1.1.0")).rejects.toThrow("unexpected files");
    expect((await readPackage(app))?.commit).toBe(OLD);
  });

  it("rejects archive symlinks and leaves their targets alone", async () => {
    await install();
    const victim = join(dir, "victim");
    await writeFile(victim, "keep");
    await corruptArchive(async (stage) => {
      await rm(join(stage, "LICENSE"));
      await symlink(victim, join(stage, "LICENSE"));
    });
    await expect(install("v1.1.0")).rejects.toThrow("link or special file");
    expect(await readFile(victim, "utf8")).toBe("keep");
    expect((await readPackage(app))?.commit).toBe(OLD);
  });

  it("preserves an existing checkout and carries settings to the sibling runtime", async () => {
    await mkdir(join(app, ".git"), { recursive: true });
    await writeFile(join(app, "source.ts"), "local changes");
    await writeFile(join(app, ".env"), "MAJHI_PORT=7072\n");
    await install();
    expect(await readFile(join(app, "source.ts"), "utf8")).toBe("local changes");
    expect((await readPackage(`${app}-runtime`))?.commit).toBe(OLD);
    expect(await readFile(join(`${app}-runtime`, ".env"), "utf8")).toContain("MAJHI_PORT=7072");
  });

  it.each(["build", "start"])(
    "restores runtime files and settings when an update fails at %s",
    async (failure) => {
      await install();
      const original = await readFile(join(app, ".env"), "utf8");
      const home = join(dir, "home");
      await mkdir(home);
      const key = join(dir, "key");
      await writeFile(key, "existing key");
      const calls: string[] = [];
      let failed = false;
      const dockerExec: GitContext["exec"] = async (file, args, opts) => {
        if (file !== "/fake/docker") return exec(file, args, opts);
        const line = args.join(" ");
        calls.push(line);
        if (
          (!failed && failure === "build" && line.endsWith(" build")) ||
          (!failed && failure === "start" && line === "compose up -d --wait")
        ) {
          failed = true;
          throw new Error("failed");
        }
        if (line.startsWith("image inspect")) return { stdout: "sha256:previous", stderr: "" };
        if (line.startsWith("container inspect")) throw new Error("no Laya");
        if (line.startsWith("compose run")) return { stdout: "services: {}\n", stderr: "" };
        return { stdout: "", stderr: "" };
      };
      const start = createUpdater({
        git: { ...ctx(), exec: dockerExec },
        remount: {
          repo: app,
          docker: "/fake/docker",
          env: { HOME: dir, MAJHI_LAYA: "off" },
          exec: dockerExec,
          log: () => undefined,
        },
        majhiHome: home,
        bundle: join(home, "helper"),
        selfPath: "elsewhere",
        secretsKeyFile: key,
        log: () => undefined,
        exit: () => undefined,
        sleep: async () => undefined,
      });
      expect(start()).toBe(true);
      let status: { state: string } | undefined;
      for (let i = 0; i < 300; i++) {
        status = await readFile(join(home, "update.json"), "utf8").then(
          (s) => JSON.parse(s) as { state: string },
          () => undefined,
        );
        if (status && status.state !== "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(status?.state).toBe("failed");
      expect(await readPackage(app)).toEqual({ version: "v1.0.0", commit: OLD });
      expect(await readFile(join(app, ".env"), "utf8")).toBe(original);
      if (failure === "start") expect(calls.at(-1)).toBe("compose up -d --wait");
    },
  );
});

import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTargetReader,
  FETCH_EVERY_MS,
  moveBack,
  moveToNewest,
  versionIn,
  withVersion,
} from "./release.ts";
import type { GitContext } from "./repoInfo.ts";

const exec = promisify(execFile);
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const ID = ["-c", "user.name=T", "-c", "user.email=t@acme.test"];

describe(".env MAJHI_VERSION", () => {
  it("reads the last value, without quotes, and none when unset or empty", () => {
    expect(versionIn("MAJHI_PORT=7071\nMAJHI_VERSION=v1.0.0\nMAJHI_VERSION='v1.2.0'\r\n")).toBe("v1.2.0");
    expect(versionIn("# MAJHI_VERSION=v1.0.0\nMAJHI_PORT=7071\n")).toBeUndefined();
    expect(versionIn("MAJHI_VERSION=\n")).toBeUndefined();
  });

  it("sets the version and keeps every other line of the owner's", () => {
    expect(withVersion("MAJHI_PORT=7071\nMAJHI_VERSION=v1.0.0\n# note\n", "v1.1.0")).toBe(
      "MAJHI_PORT=7071\n# note\nMAJHI_VERSION=v1.1.0\n",
    );
    expect(withVersion("", "v1.1.0")).toBe("MAJHI_VERSION=v1.1.0\n");
  });
});

describe("release install", () => {
  let dir: string;
  let origin: string;
  let app: string;
  const env = () => ({ PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" });
  const git = (cwd: string, ...args: string[]) =>
    exec("git", ["-C", cwd, ...ID, ...args], { env: env() }).then((r) => r.stdout.trim());
  const ctx = (): GitContext => ({ git: "git", repo: app, env: env(), exec });
  const commitAndTag = async (tag: string) => {
    await writeFile(join(origin, "VERSION"), tag);
    await git(origin, "add", "-A");
    await git(origin, "commit", "-q", "-m", `release ${tag}`);
    await git(origin, "tag", tag);
    return git(origin, "rev-parse", "HEAD");
  };

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "majhi-release-")));
    origin = join(dir, "origin");
    app = join(dir, "app");
    await exec("git", ["init", "-q", "-b", "main", origin], { env: env() });
    await writeFile(join(origin, ".gitignore"), ".env\n");
    await commitAndTag("v0.9.0");
    // install.sh's checkout, at v0.9.0, with the owner's settings next to the version.
    await exec("git", ["clone", "-q", origin, app], { env: env() });
    await git(app, "checkout", "-q", "--detach", "v0.9.0");
    await writeFile(join(app, ".env"), "MAJHI_PORT=7071\nMAJHI_VERSION=v0.9.0\n");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("moves to the newest release by version, not by name, and back again", async () => {
    await commitAndTag("v0.10.0");
    const newest = await git(origin, "rev-parse", "HEAD");
    // Not a release: the newest by name, and a pre-release.
    await git(origin, "tag", "v0.2.0-rc.1");
    await git(origin, "tag", "vnext");
    const head = await git(app, "rev-parse", "HEAD");
    const said: string[] = [];

    const moved = await moveToNewest(ctx(), head, async (text) => void said.push(text));
    expect(moved).toMatchObject({ from: "v0.9.0", to: "v0.10.0", head });
    expect(await git(app, "rev-parse", "HEAD")).toBe(newest);
    expect(await readFile(join(app, ".env"), "utf8")).toBe("MAJHI_PORT=7071\nMAJHI_VERSION=v0.10.0\n");
    expect(said).toContain("Moving from majhi v0.9.0 to v0.10.0");

    if (moved === undefined) throw new Error("not moved");
    await moveBack(ctx(), moved);
    expect(await git(app, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(app, ".env"), "utf8")).toBe("MAJHI_PORT=7071\nMAJHI_VERSION=v0.9.0\n");
  });

  it("stays put on the newest release, and on a dev checkout", async () => {
    const head = await git(app, "rev-parse", "HEAD");
    expect(await moveToNewest(ctx(), head, async () => undefined)).toBeUndefined();

    await commitAndTag("v1.0.0");
    await writeFile(join(app, ".env"), "MAJHI_PORT=7071\n");
    expect(await moveToNewest(ctx(), head, async () => undefined)).toBeUndefined();
    expect(await git(app, "rev-parse", "HEAD")).toBe(head);
  });

  it("reports the newest release as what an update runs, and asks the remote at most every few hours", async () => {
    const head = await git(app, "rev-parse", "HEAD");
    let now = 0;
    const read = createTargetReader(ctx(), () => now);
    expect(await read()).toEqual({ commit: head, dirty: false });

    const newer = await commitAndTag("v0.9.1");
    now += FETCH_EVERY_MS - 1;
    expect((await read())?.commit).toBe(head);
    now += 1;
    expect((await read())?.commit).toBe(newer);
    // The checkout itself does not move until the update.
    expect(await git(app, "rev-parse", "HEAD")).toBe(head);
  });

  it("reports HEAD on a dev checkout and never fetches", async () => {
    await writeFile(join(app, ".env"), "");
    await commitAndTag("v2.0.0");
    const head = await git(app, "rev-parse", "HEAD");
    expect(await createTargetReader(ctx(), () => 0)()).toEqual({ commit: head, dirty: false });
    expect(await git(app, "tag", "--list", "v2.0.0")).toBe("");
  });
});

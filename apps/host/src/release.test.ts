import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECK_EVERY_MS,
  createTargetReader,
  dotenvValue,
  moveBack,
  moveToLatest,
  readLatest,
  releaseIn,
  withVersion,
} from "./release.ts";
import type { GitContext } from "./repoInfo.ts";

const exec = promisify(execFile);
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const ID = ["-c", "user.name=T", "-c", "user.email=t@acme.test"];
const LATEST = "https://api.github.example/repos/acme/majhi/releases/latest";

describe(".env release lines", () => {
  it("reads the last value, without quotes, and none when unset or empty", () => {
    const text = "MAJHI_PORT=7071\nMAJHI_VERSION=v1.0.0\nMAJHI_VERSION='v1.2.0'\r\n";
    expect(dotenvValue(text, "MAJHI_VERSION")).toBe("v1.2.0");
    expect(dotenvValue("# MAJHI_VERSION=v1.0.0\nMAJHI_PORT=7071\n", "MAJHI_VERSION")).toBeUndefined();
    expect(dotenvValue("MAJHI_VERSION=\n", "MAJHI_VERSION")).toBeUndefined();
    expect(releaseIn(`MAJHI_VERSION=v1.0.0\nMAJHI_LATEST_URL=${LATEST}\n`)).toEqual({
      version: "v1.0.0",
      latestUrl: LATEST,
    });
    expect(releaseIn(`MAJHI_LATEST_URL=${LATEST}\n`)).toBeUndefined();
  });

  it("sets the version and keeps every other line of the owner's", () => {
    expect(
      withVersion(`MAJHI_PORT=7071\nMAJHI_VERSION=v1.0.0\n# note\nMAJHI_LATEST_URL=${LATEST}\n`, "v1.1.0"),
    ).toBe(`MAJHI_PORT=7071\n# note\nMAJHI_LATEST_URL=${LATEST}\nMAJHI_VERSION=v1.1.0\n`);
    expect(withVersion("MAJHI_VERSION=\n", "v1.1.0")).toBe("MAJHI_VERSION=v1.1.0\n");
  });
});

describe("the latest-release pointer", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  /** A pointer on 127.0.0.1 that answers `status` with `body`. */
  const serve = async (status: number, body: unknown): Promise<string> => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => new Promise((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`;
  };

  it("reads the tag of the latest release", async () => {
    expect(await readLatest(await serve(200, { tag_name: "v1.4.0", name: "majhi v1.4.0" }))).toBe("v1.4.0");
  });

  it("refuses anything but a vX.Y.Z tag, so git never sees it", async () => {
    await expect(readLatest(await serve(200, { tag_name: "v1.4.0 --upload-pack=x" }))).rejects.toThrow(
      "names no majhi release",
    );
    await close?.();
    await expect(readLatest(await serve(200, { tag_name: "v2.0.0-rc.1" }))).rejects.toThrow(
      "names no majhi release",
    );
  });

  it("says what the pointer answered when there is no release", async () => {
    await expect(readLatest(await serve(404, { message: "Not Found" }))).rejects.toThrow("answered 404");
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
  const dotenv = `MAJHI_PORT=7071\nMAJHI_VERSION=v0.9.0\nMAJHI_LATEST_URL=${LATEST}\n`;
  /** A pointer that names `tag` and counts the asks. */
  const pointer = (tag: string | Error) => {
    const asked: string[] = [];
    const latest = async (url: string) => {
      asked.push(url);
      if (tag instanceof Error) throw tag;
      return tag;
    };
    return { asked, latest };
  };

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "majhi-release-")));
    origin = join(dir, "origin");
    app = join(dir, "app");
    await exec("git", ["init", "-q", "-b", "main", origin], { env: env() });
    await writeFile(join(origin, ".gitignore"), ".env\n");
    await commitAndTag("v0.9.0");
    // install.sh's checkout, at v0.9.0, with the owner's settings next to the release lines.
    await exec("git", ["clone", "-q", origin, app], { env: env() });
    await git(app, "checkout", "-q", "--detach", "v0.9.0");
    await writeFile(join(app, ".env"), dotenv);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("moves to the release the pointer names, fetching its tag, and back again", async () => {
    const latest = await commitAndTag("v0.10.0");
    // A newer tag the pointer does not name yet: its images may still be building.
    await commitAndTag("v0.11.0");
    const head = await git(app, "rev-parse", "HEAD");
    const said: string[] = [];
    const p = pointer("v0.10.0");

    const moved = await moveToLatest(ctx(), head, async (text) => void said.push(text), p.latest);
    expect(p.asked).toEqual([LATEST]);
    expect(moved).toMatchObject({ from: "v0.9.0", to: "v0.10.0", head });
    expect(await git(app, "rev-parse", "HEAD")).toBe(latest);
    expect(await readFile(join(app, ".env"), "utf8")).toBe(
      `MAJHI_PORT=7071\nMAJHI_LATEST_URL=${LATEST}\nMAJHI_VERSION=v0.10.0\n`,
    );
    expect(said).toContain("Moving from majhi v0.9.0 to v0.10.0");

    if (moved === undefined) throw new Error("not moved");
    await moveBack(ctx(), moved);
    expect(await git(app, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(app, ".env"), "utf8")).toBe(dotenv);
  });

  it("stays put on the latest release, without a pointer, and on a dev checkout", async () => {
    const head = await git(app, "rev-parse", "HEAD");
    expect(await moveToLatest(ctx(), head, async () => undefined, pointer("v0.9.0").latest)).toBeUndefined();

    await commitAndTag("v1.0.0");
    const unasked = pointer("v1.0.0");
    await writeFile(join(app, ".env"), "MAJHI_VERSION=v0.9.0\n");
    expect(await moveToLatest(ctx(), head, async () => undefined, unasked.latest)).toBeUndefined();
    await writeFile(join(app, ".env"), "MAJHI_PORT=7071\n");
    expect(await moveToLatest(ctx(), head, async () => undefined, unasked.latest)).toBeUndefined();
    expect(unasked.asked).toEqual([]);
    expect(await git(app, "rev-parse", "HEAD")).toBe(head);
  });

  it("moves nothing when the pointer cannot be read or names a tag the remote lacks", async () => {
    const head = await git(app, "rev-parse", "HEAD");
    await expect(
      moveToLatest(ctx(), head, async () => undefined, pointer(new Error("answered 503")).latest),
    ).rejects.toThrow("answered 503");
    await expect(moveToLatest(ctx(), head, async () => undefined, pointer("v7.0.0").latest)).rejects.toThrow(
      "v7.0.0 is not in the checkout's remote",
    );
    expect(await git(app, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(app, ".env"), "utf8")).toBe(dotenv);
  });

  it("reports the latest release as what an update runs, asking at most every few hours", async () => {
    const head = await git(app, "rev-parse", "HEAD");
    let now = 0;
    let tag = "v0.9.0";
    let asks = 0;
    const read = createTargetReader(ctx(), {
      now: () => now,
      latest: async () => {
        asks += 1;
        return tag;
      },
    });
    expect(await read()).toEqual({ commit: head, dirty: false });

    const newer = await commitAndTag("v0.9.1");
    tag = "v0.9.1";
    now += CHECK_EVERY_MS - 1;
    expect((await read())?.commit).toBe(head);
    now += 1;
    expect((await read())?.commit).toBe(newer);
    expect(asks).toBe(2);
    // The checkout itself does not move until the update.
    expect(await git(app, "rev-parse", "HEAD")).toBe(head);
  });

  it("keeps the last answer when the pointer cannot be read", async () => {
    const newer = await commitAndTag("v0.9.1");
    let now = 0;
    let fail = false;
    const read = createTargetReader(ctx(), {
      now: () => now,
      latest: async () => {
        if (fail) throw new Error("offline");
        return "v0.9.1";
      },
    });
    expect((await read())?.commit).toBe(newer);
    fail = true;
    now += CHECK_EVERY_MS;
    expect((await read())?.commit).toBe(newer);
  });

  it("reports HEAD on a dev checkout and never asks", async () => {
    await writeFile(join(app, ".env"), "");
    await commitAndTag("v2.0.0");
    const head = await git(app, "rev-parse", "HEAD");
    const p = pointer("v2.0.0");
    expect(await createTargetReader(ctx(), { now: () => 0, latest: p.latest })()).toEqual({
      commit: head,
      dirty: false,
    });
    expect(p.asked).toEqual([]);
    expect(await git(app, "tag", "--list", "v2.0.0")).toBe("");
  });
});

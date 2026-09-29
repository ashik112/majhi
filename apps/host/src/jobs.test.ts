import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostReply } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANNOT_REMOUNT, type JobHandlers, runJob } from "./jobs.ts";
import { composeEnv, createRemounter, type ExecFn, type ExecOptions, OVERRIDE_FILE } from "./remount.ts";

const OVERRIDE = "services:\n  server:\n    volumes:\n      - /Users/a/Work:/Users/a/Work\n";

describe("host jobs", () => {
  let repo: string;
  let events: string[];
  let calls: Array<{ file: string; args: readonly string[]; options: ExecOptions }>;
  let logs: string[];
  let replies: HostReply[];

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "majhi-host-test-"));
    events = [];
    calls = [];
    logs = [];
    replies = [];
  });
  afterEach(() => rm(repo, { recursive: true, force: true }));

  const env = composeEnv(
    { KEEP: "1", HOME: "/wrong" },
    { home: "/Users/a", uid: 501, gid: 20, path: "/usr/bin:/usr/local/bin" },
  );
  const fakeExec =
    (fail?: string): ExecFn =>
    async (file, args, options) => {
      calls.push({ file, args, options });
      events.push(`exec ${args.slice(0, 2).join(" ")}`);
      if (fail !== undefined && args.includes(fail)) {
        throw Object.assign(new Error("Command failed"), { stderr: "no such service: server" });
      }
      return { stdout: args[1] === "run" ? OVERRIDE : "", stderr: "" };
    };
  const handlers = (exec: ExecFn): JobHandlers => ({
    listDirs: async () => {
      throw new Error("There is no folder at /nope");
    },
    suggestRoots: async () => [{ path: "/Users/a/Work", repoCount: 2 }],
    remount: createRemounter({ repo, docker: "/usr/local/bin/docker", env, exec, log: (m) => logs.push(m) }),
  });
  const reply = async (r: HostReply) => {
    replies.push(r);
    events.push(`reply ${r.ok ? "ok" : "error"}`);
  };

  it("answers remount first, then generates the override and recreates the server in the repo", async () => {
    await runJob({ id: "j1", method: "remount", params: {} }, handlers(fakeExec()), reply);

    expect(events).toEqual(["reply ok", "exec compose run", "exec compose up"]);
    expect(replies.at(-1)).toEqual({ id: "j1", ok: true, result: { accepted: true } });
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([
      [
        "/usr/local/bin/docker",
        "compose",
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "server",
        "node",
        "dist/cli.js",
        "gen-override",
      ],
      ["/usr/local/bin/docker", "compose", "up", "-d", "--wait"],
    ]);
    for (const call of calls) {
      expect(call.options.cwd).toBe(repo);
      expect(call.options.env).toMatchObject({
        KEEP: "1",
        HOME: "/Users/a",
        HOST_UID: "501",
        HOST_GID: "20",
        PATH: "/usr/bin:/usr/local/bin",
      });
    }
    expect(await readFile(join(repo, OVERRIDE_FILE), "utf8")).toBe(OVERRIDE);
    expect(await readdir(repo)).toEqual([OVERRIDE_FILE]);
    expect(logs.at(-1)).toMatch(/^remount: done in \d+\.\ds$/);
  });

  it("keeps the old override and skips the restart when generating the mounts fails", async () => {
    await writeFile(join(repo, OVERRIDE_FILE), "old");
    await runJob({ id: "j2", method: "remount", params: {} }, handlers(fakeExec("run")), reply);

    expect(events).toEqual(["reply ok", "exec compose run"]);
    expect(await readFile(join(repo, OVERRIDE_FILE), "utf8")).toBe("old");
    expect(await readdir(repo)).toEqual([OVERRIDE_FILE]);
    expect(logs.at(-1)).toContain("generate mounts failed: Command failed\nno such service: server");
  });

  it("runs one remount at a time", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upStarted = () => {};
    const started = new Promise<void>((resolve) => {
      upStarted = resolve;
    });
    const slowExec: ExecFn = async (file, args, options) => {
      if (args[1] === "up") {
        events.push("up started");
        upStarted();
        await gate;
        events.push("up finished");
        return { stdout: "", stderr: "" };
      }
      return fakeExec()(file, args, options);
    };
    const { remount } = handlers(slowExec);
    const first = remount?.();
    const second = remount?.();
    await started;
    expect(events).toEqual(["exec compose run", "up started"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "exec compose run",
      "up started",
      "up finished",
      "exec compose run",
      "up started",
      "up finished",
    ]);
  });

  it("refuses remount when the helper cannot run docker compose", async () => {
    await runJob(
      { id: "j3", method: "remount", params: {} },
      { ...handlers(fakeExec()), remount: undefined },
      reply,
    );
    expect(replies.at(-1)).toEqual({ id: "j3", ok: false, error: CANNOT_REMOUNT });
    expect(calls).toEqual([]);
  });

  it("answers a failing job with its message, and a working one with its result", async () => {
    const h = handlers(fakeExec());
    await runJob({ id: "j4", method: "listDirs", params: { path: "/nope", showHidden: false } }, h, reply);
    await runJob({ id: "j5", method: "suggestRoots", params: {} }, h, reply);
    expect(replies.slice(-2)).toEqual([
      { id: "j4", ok: false, error: "There is no folder at /nope" },
      { id: "j5", ok: true, result: { suggestions: [{ path: "/Users/a/Work", repoCount: 2 }] } },
    ]);
  });
});

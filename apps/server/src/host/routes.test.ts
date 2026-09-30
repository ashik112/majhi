import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_INFO_HEADER, HOST_TOKEN_FILE, type HostInfo, HostJobSchema } from "@majhi/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "../env.ts";
import { createMajhiApp } from "../server.ts";
import { git, tempDir, testEnv } from "../testing/fixtures.ts";
import { HostLink } from "./link.ts";

const TOKEN = "0123456789abcdef".repeat(4);
const CAN_REMOUNT: HostInfo = { version: "1.0.0", platform: "darwin", canRemount: true };
const SSH_WAITING = { loaded: 1, needsPassphrase: ["~/.ssh/id_work"], checkedAt: "2026-09-29T10:00:00.000Z" };
const SSH_DONE = { loaded: 2, needsPassphrase: [], checkedAt: "2026-09-29T10:01:00.000Z" };
const NO_DOCKER: HostInfo = { ...CAN_REMOUNT, canRemount: false };

describe("host helper link over HTTP", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let env: ServerEnv;
  let app: Hono;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    env = testEnv(dir, { version: "test" });
    await mkdir(env.majhiHome);
    await writeFile(join(env.majhiHome, HOST_TOKEN_FILE), `${TOKEN}\n`);
    // Long enough that a poll only ends when a job arrives or its request is aborted.
    app = createMajhiApp(env, { hostLink: new HostLink({ pollTimeoutMs: 5_000 }) });
  });
  afterEach(() => cleanup());

  const poll = (info: HostInfo = CAN_REMOUNT, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    app.request("/api/host/poll", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, [HOST_INFO_HEADER]: JSON.stringify(info), ...headers },
      ...(signal === undefined ? {} : { signal }),
    });
  /**
   * A poll whose request is already gone: it takes a queued job if there is
   * one, else ends at once with 204. Either way the helper now counts as connected.
   */
  const quickPoll = (info: HostInfo = CAN_REMOUNT) => poll(info, {}, AbortSignal.abort());
  const reply = (body: unknown) =>
    app.request("/api/host/reply", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const cmd = (name: string, body: unknown = {}) =>
    app.request(`/api/cmd/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  /** Polls like the helper and waits for the next job. */
  const nextJob = async (info: HostInfo = CAN_REMOUNT) => {
    const res = await poll(info);
    expect(res.status).toBe(200);
    return HostJobSchema.parse(await res.json());
  };

  it("requires the token from host.token", async () => {
    const noToken = await app.request("/api/host/poll", {
      method: "POST",
      headers: { [HOST_INFO_HEADER]: JSON.stringify(CAN_REMOUNT) },
    });
    expect(noToken.status).toBe(401);
    expect((await poll(CAN_REMOUNT, { authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await poll(CAN_REMOUNT, { authorization: TOKEN })).status).toBe(401);
    expect((await reply({ id: "x", ok: true, result: {} })).status).toBe(204);

    await rm(join(env.majhiHome, HOST_TOKEN_FILE));
    expect((await quickPoll()).status).toBe(401);
    expect((await reply({ id: "x", ok: true, result: {} })).status).toBe(401);
  });

  it("refuses browser requests, even from a local page with the right token", async () => {
    const res = await poll(CAN_REMOUNT, { origin: "http://127.0.0.1:7070" });
    expect(res.status).toBe(403);
  });

  it("answers an idle poll with 204 and rejects a poll without valid helper info", async () => {
    // A short poll timeout, so the idle poll really times out.
    app = createMajhiApp(env, { hostLink: new HostLink({ pollTimeoutMs: 20 }) });
    expect((await poll()).status).toBe(204);
    const bad = await app.request("/api/host/poll", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, [HOST_INFO_HEADER]: '{"version":"1"}' },
    });
    expect(bad.status).toBe(400);
    expect((await reply({ id: "x", ok: "yes" })).status).toBe(400);
  });

  it("answers 503 host-offline without a helper, and 400 with the helper's message when a job fails", async () => {
    const offline = await cmd("fs.suggestRoots");
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ error: "host-offline", details: [expect.any(String)] });

    await quickPoll();
    const pending = cmd("fs.listDirs", { path: "/nope" });
    const job = await nextJob();
    await reply({ id: job.id, ok: false, error: "There is no folder at /nope" });
    const failed = await pending;
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "There is no folder at /nope" });
  });

  describe("remounting after workspaces.set", () => {
    it("falls back to manual without a helper", async () => {
      const res = await cmd("workspaces.set", { workspaces: ["~/Later"] });
      expect(await res.json()).toMatchObject({ remount: "manual", unmounted: [join(dir, "Later")] });
    });

    it("falls back to manual when the helper cannot run Docker, and sends no job", async () => {
      await quickPoll(NO_DOCKER);
      const res = await cmd("workspaces.set", { workspaces: ["~/Later"] });
      expect(await res.json()).toMatchObject({ remount: "manual" });
      expect((await quickPoll(NO_DOCKER)).status).toBe(204);
    });

    it("falls back to manual when the helper refuses the job", async () => {
      await quickPoll();
      const pending = cmd("workspaces.set", { workspaces: ["~/Later"] });
      const job = await nextJob();
      await reply({ id: job.id, ok: false, error: "cannot run docker compose" });
      expect(await (await pending).json()).toMatchObject({ remount: "manual" });
    });

    it("remounts on workspaces.remount without touching majhi.yaml", async () => {
      await cmd("workspaces.set", { workspaces: ["~/Later"] });
      const file = await readFile(join(env.majhiHome, "majhi.yaml"), "utf8");
      const head = await git(env.majhiHome, "rev-parse", "HEAD");

      await quickPoll();
      const pending = cmd("workspaces.remount");
      const job = await nextJob();
      expect(job.method).toBe("remount");
      await reply({ id: job.id, ok: true, result: { accepted: true } });
      expect(await (await pending).json()).toEqual({
        remount: "restarting",
        unmounted: [join(dir, "Later")],
      });

      expect(await readFile(join(env.majhiHome, "majhi.yaml"), "utf8")).toBe(file);
      expect(await git(env.majhiHome, "rev-parse", "HEAD")).toBe(head);
    });
  });

  describe("SSH keys", () => {
    it("shows what the helper reported in host.status, and reloads on ssh.reload", async () => {
      await quickPoll({ ...CAN_REMOUNT, ssh: SSH_WAITING });
      expect(await (await cmd("host.status")).json()).toMatchObject({ info: { ssh: SSH_WAITING } });

      const pending = cmd("ssh.reload");
      const job = await nextJob({ ...CAN_REMOUNT, ssh: SSH_WAITING });
      expect(job).toMatchObject({ method: "ssh.reload", params: {} });
      await reply({ id: job.id, ok: true, result: SSH_DONE });
      expect(await (await pending).json()).toEqual(SSH_DONE);
      expect(await (await cmd("host.status")).json()).toMatchObject({ info: { ssh: SSH_DONE } });
    });

    it("unlocks only a key the helper reported, and never lets the passphrase out", async () => {
      const PASSPHRASE = "hunter2-correct-horse";
      const seen: string[] = [];
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
        vi.spyOn(console, name).mockImplementation((...args: unknown[]) => void seen.push(args.join(" "))),
      );
      try {
        await quickPoll({ ...CAN_REMOUNT, ssh: SSH_WAITING });

        const notWaiting = await cmd("ssh.unlock", { key: "~/.ssh/id_other", passphrase: PASSPHRASE });
        expect(notWaiting.status).toBe(400);
        expect(await notWaiting.json()).toEqual({
          error: "~/.ssh/id_other is not waiting for a passphrase.",
        });
        expect((await quickPoll({ ...CAN_REMOUNT, ssh: SSH_WAITING })).status).toBe(204);

        const tooLong = await cmd("ssh.unlock", { key: "~/.ssh/id_work", passphrase: "x".repeat(2000) });
        expect(tooLong.status).toBe(400);

        // The wrong passphrase: the helper's plain sentence comes back, and nothing else.
        const wrong = cmd("ssh.unlock", { key: "~/.ssh/id_work", passphrase: PASSPHRASE });
        const job = await nextJob({ ...CAN_REMOUNT, ssh: SSH_WAITING });
        expect(job).toMatchObject({
          method: "ssh.unlock",
          params: { key: "~/.ssh/id_work", passphrase: PASSPHRASE },
        });
        await reply({ id: job.id, ok: false, error: "That passphrase did not unlock ~/.ssh/id_work." });
        const failed = await wrong;
        expect(failed.status).toBe(400);
        const failedText = await failed.text();
        expect(JSON.parse(failedText)).toEqual({ error: "That passphrase did not unlock ~/.ssh/id_work." });

        const right = cmd("ssh.unlock", { key: "~/.ssh/id_work", passphrase: PASSPHRASE });
        const job2 = await nextJob({ ...CAN_REMOUNT, ssh: SSH_WAITING });
        await reply({ id: job2.id, ok: true, result: SSH_DONE });
        const done = await right;
        const doneText = await done.text();
        expect(JSON.parse(doneText)).toEqual(SSH_DONE);

        // Not in any answer, in the status, in the command history, or in anything logged.
        const status = await (await cmd("host.status")).text();
        const history = await git(env.majhiHome, "log", "--all", "-p").catch(() => "");
        for (const text of [failedText, doneText, status, history, seen.join("\n")]) {
          expect(text).not.toContain(PASSPHRASE);
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_INFO_HEADER, HOST_TOKEN_FILE, type HostInfo, HostJobSchema } from "@majhi/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEnv } from "../env.ts";
import { createMajhiApp } from "../server.ts";
import { git, tempDir, testEnv } from "../testing/fixtures.ts";
import { HostLink } from "./link.ts";

const TOKEN = "0123456789abcdef".repeat(4);
const CAN_REMOUNT: HostInfo = { version: "1.0.0", platform: "darwin", canRemount: true };
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

  it("runs fs.listDirs through the helper, defaulting to the host home", async () => {
    expect(await (await cmd("host.status")).json()).toEqual({ connected: false });
    await quickPoll();

    const pending = cmd("fs.listDirs");
    const job = await nextJob();
    expect(job).toMatchObject({ method: "listDirs", params: { path: dir, showHidden: false } });
    const listing = { path: dir, parent: "/", home: dir, entries: [], truncated: false };
    expect((await reply({ id: job.id, ok: true, result: listing })).status).toBe(204);

    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(listing);
    expect(await (await cmd("host.status")).json()).toMatchObject({ connected: true, info: CAN_REMOUNT });
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
    it("is not needed when every root is visible, and sends no job", async () => {
      await mkdir(join(dir, "Work"));
      await quickPoll();
      const res = await cmd("workspaces.set", { workspaces: ["~/Work"] });
      expect(await res.json()).toMatchObject({ remount: "not-needed", unmounted: [] });
      expect((await quickPoll()).status).toBe(204);
    });

    it("asks a connected helper that can remount, and says majhi is restarting", async () => {
      await quickPoll();
      const pending = cmd("workspaces.set", { workspaces: ["~/Later"] });
      const job = await nextJob();
      expect(job).toMatchObject({ method: "remount", params: {} });
      await reply({ id: job.id, ok: true, result: { accepted: true } });

      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        remount: "restarting",
        unmounted: [join(dir, "Later")],
        restartCommand: "make up",
      });
    });

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
});

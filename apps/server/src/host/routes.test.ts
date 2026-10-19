import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_INFO_HEADER, HOST_TOKEN_FILE, type HostInfo } from "@majhi/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEnv } from "../env.ts";
import { createMajhiApp } from "../server.ts";
import { tempDir, testEnv } from "../testing/fixtures.ts";
import { HostLink } from "./link.ts";

const TOKEN = "0123456789abcdef".repeat(4);
const CAN_REMOUNT: HostInfo = { version: "1.0.0", platform: "darwin", canRemount: true };

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

  it.each<[string, () => Promise<void>]>([
    [
      "a request without the token from host.token",
      async () => {
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
      },
    ],
    [
      "a browser request, even from a local page with the right token",
      async () => {
        await writeFile(join(env.majhiHome, HOST_TOKEN_FILE), `${TOKEN}\n`);
        const res = await poll(CAN_REMOUNT, { origin: "http://127.0.0.1:7070" });
        expect(res.status).toBe(403);
      },
    ],
  ])("answers only requests with its token, and never a browser: refuses %s", async (_name, run) => {
    await run();
  });
});

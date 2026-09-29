import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMMAND_META_HEADER } from "@majhi/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEnv } from "../env.ts";
import { createMajhiApp } from "../server.ts";
import { git, makeRepo, tempDir, testEnv } from "../testing/fixtures.ts";

describe("HTTP API", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let env: ServerEnv;
  let app: Hono;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    env = testEnv(dir, { version: "1.2.3-test" });
    app = createMajhiApp(env);
  });
  afterEach(() => cleanup());

  const cmd = (name: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api/cmd/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? null : JSON.stringify(body),
    });

  it("answers /health with the version", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "1.2.3-test" });
  });

  it("goes from first run to scanned repos through the commands", async () => {
    const first = await cmd("config.get");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      status: "first-run",
      file: join(dir, ".majhi/majhi.yaml"),
      home: dir,
    });

    expect(await (await cmd("repos.scan", {})).json()).toMatchObject({ roots: [] });

    await makeRepo(join(dir, "Work/acme/api"), { remotes: { origin: "git@github.com:acme/api.git" } });
    const set = await cmd("workspaces.set", { workspaces: ["~/Work", "~/Later"] });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({
      state: {
        status: "loaded",
        file: join(dir, ".majhi/majhi.yaml"),
        home: dir,
        config: { workspaces: [join(dir, "Work"), join(dir, "Later")], tasksDir: join(dir, "Work/.majhi") },
      },
      unmounted: [join(dir, "Later")],
      remount: "manual",
      restartCommand: "make up",
    });

    expect(await (await cmd("config.get", {})).json()).toMatchObject({ status: "loaded" });

    const scan = await cmd("repos.scan", { refresh: true });
    expect(scan.status).toBe(200);
    expect(await scan.json()).toMatchObject({
      roots: [
        {
          path: join(dir, "Work"),
          mounted: true,
          repos: [{ name: "api", relPath: "acme/api", remotes: [{ name: "origin", host: "github" }] }],
        },
        { path: join(dir, "Later"), mounted: false, repos: [] },
      ],
      durationMs: expect.any(Number),
    });
  });

  it("rejects invalid input with 400 and readable details", async () => {
    const res = await cmd("workspaces.set", { workspaces: ["Work"], extra: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid input",
      details: ["workspaces[0]: Use an absolute path, or one starting with ~/"],
    });

    const badJson = await app.request("/api/cmd/config.get", { method: "POST", body: "{nope" });
    expect(badJson.status).toBe(400);

    const badMeta = await cmd("config.get", {}, { [COMMAND_META_HEADER]: '{"actor":{"kind":"agent"}}' });
    expect(badMeta.status).toBe(400);
    expect(await badMeta.json()).toMatchObject({ error: "Invalid x-majhi-meta header" });
  });

  it("answers 404 with an ApiError for unknown commands and API paths", async () => {
    const res = await cmd("repos.delete", {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown command: repos.delete" });
    expect((await cmd("toString", {})).status).toBe(404);
    expect((await app.request("/api/cmd/config.get")).status).toBe(404);
  });

  it("records the meta header in the config history", async () => {
    const meta = { actor: { kind: "agent", id: "majhi-boss" }, reason: "owner asked to add ~/Work" };
    const res = await cmd(
      "workspaces.set",
      { workspaces: ["~/Work"] },
      { [COMMAND_META_HEADER]: JSON.stringify(meta) },
    );
    expect(res.status).toBe(200);
    expect(await git(env.majhiHome, "log", "-1", "--format=%an <%ae>|%s")).toBe(
      "majhi-boss <majhi-boss@majhi.local>|workspaces.set: owner asked to add ~/Work",
    );
  });

  it("answers 409 when majhi.yaml cannot be edited safely", async () => {
    await mkdir(env.majhiHome, { recursive: true });
    await writeFile(join(env.majhiHome, "majhi.yaml"), "workspaces: [~/Work\n");
    const res = await cmd("workspaces.set", { workspaces: ["~/Work"] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("YAML errors") });
  });

  it("blocks commands from other websites but not from loopback pages", async () => {
    const evil = await cmd("workspaces.set", { workspaces: ["/"] }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const local = await cmd("config.get", {}, { origin: "http://localhost:5173" });
    expect(local.status).toBe(200);
  });

  it("says the web app is not built when there is no dist folder", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("web app is not built");
  });

  it("serves the web app with a fallback to index.html for client routes", async () => {
    await mkdir(join(env.webDist, "assets"), { recursive: true });
    await writeFile(join(env.webDist, "index.html"), "<!doctype html><title>majhi</title>");
    await writeFile(join(env.webDist, "assets", "app.js"), "console.log(1)");
    app = createMajhiApp(env);

    expect(await (await app.request("/")).text()).toContain("<title>majhi</title>");
    expect(await (await app.request("/settings/roots")).text()).toContain("<title>majhi</title>");
    const js = await app.request("/assets/app.js");
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(await js.text()).toBe("console.log(1)");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect((await app.request("/health")).headers.get("content-type")).toMatch(/json/);
  });
});

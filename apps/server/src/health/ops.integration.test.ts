import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandOutput, HostInfo, HostJob, HostMethod } from "@majhi/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostLink } from "../host/link.ts";
import { createMajhiApp } from "../server.ts";
import { fakeRuntime } from "../testing/fakeRuntime.ts";
import { tempDir, testEnv } from "../testing/fixtures.ts";

const RUNNING = "aaaaaaa1111111111111111111111111111111aa";
const ON_DISK = "bbbbbbb2222222222222222222222222222222bb";
const INFO: HostInfo = {
  version: "1.0.0",
  platform: "darwin",
  canRemount: true,
  commit: ON_DISK,
  dirty: true,
};
const SSH = { loaded: 2, needsPassphrase: [], checkedAt: "2026-09-30T10:00:00.000Z" };

type Answer = unknown | ((job: HostJob) => unknown);

/** Stands in for the host helper: polls the link and answers each job from `answers`. */
function fakeHelper(link: HostLink, info: HostInfo, answers: Partial<Record<HostMethod, Answer>>) {
  const seen: HostJob[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const job = await link.poll(info);
      if (job === undefined) continue;
      seen.push(job);
      const answer = answers[job.method];
      if (answer instanceof Error) link.reply({ id: job.id, ok: false, error: answer.message });
      else link.reply({ id: job.id, ok: true, result: typeof answer === "function" ? answer(job) : answer });
    }
  })();
  return {
    seen,
    async stop() {
      stopped = true;
      link.close();
      await loop;
    },
  };
}

describe("health.run, health.fix, system.version and system.update", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let app: Hono;
  let link: HostLink;
  let helper: ReturnType<typeof fakeHelper> | undefined;

  const cmd = async <T = unknown>(name: string, body: unknown = {}): Promise<{ status: number; body: T }> => {
    const res = await app.request(`/api/cmd/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const startHelper = (info: HostInfo, answers: Partial<Record<HostMethod, Answer>>) => {
    helper = fakeHelper(link, info, answers);
  };
  const untilConnected = async () => {
    for (let i = 0; i < 100 && !link.isConnected(); i += 1) await new Promise((r) => setTimeout(r, 5));
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    const env = testEnv(dir, { commit: RUNNING });
    await mkdir(env.majhiHome, { recursive: true });
    await writeFile(
      join(env.majhiHome, "majhi.yaml"),
      `workspaces: [${dir}/Work]\ntasks_dir: ${dir}/tasks\n`,
    );
    link = new HostLink({ pollTimeoutMs: 20 });
    app = createMajhiApp(env, { hostLink: link, runtime: fakeRuntime() });
  });
  afterEach(async () => {
    await helper?.stop();
    helper = undefined;
    await cleanup();
  });

  const checks = async () => (await cmd<CommandOutput<"health.run">>("health.run")).body.checks;
  const byId = (list: Awaited<ReturnType<typeof checks>>, id: string) => list.find((c) => c.id === id);

  it("offers a fix for a missing root and a missing tasks folder when the helper can remount", async () => {
    startHelper(INFO, {});
    await untilConnected();
    const list = await checks();
    expect(byId(list, `root:${dir}/Work`)).toMatchObject({
      group: "host",
      ok: false,
      level: "fail",
      fix: { label: "Mount it" },
    });
    expect(byId(list, "tasks-dir")).toMatchObject({
      ok: true,
      level: "warn",
      fix: { label: "Create folder" },
    });
    expect(byId(list, "host-helper")).toMatchObject({ ok: true, level: "pass" });
    expect(byId(list, "config")).toMatchObject({ level: "pass" });
    expect(list.map((c) => c.id)).toEqual(
      expect.arrayContaining(["git", "ssh-agent", "disk", "secrets-key", "tool:claude", "tool:codex"]),
    );
  });

  it("says exactly what to do when no helper is connected, and offers no fix", async () => {
    const list = await checks();
    const root = byId(list, `root:${dir}/Work`);
    expect(root?.fix).toBeUndefined();
    expect(root?.detail).toContain("make up");
    expect(byId(list, "host-helper")).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("make up"),
    });
  });

  it("fixes a missing tasks folder by creating it", async () => {
    const out = await cmd("health.fix", { id: "tasks-dir" });
    expect(out.body).toEqual({ ok: true, detail: "Created the tasks folder." });
    expect((await stat(join(dir, "tasks"))).isDirectory()).toBe(true);
    expect(byId(await checks(), "tasks-dir")).toMatchObject({ level: "pass" });
  });

  it("fixes an unmounted root by asking the helper to remount", async () => {
    startHelper(INFO, { remount: { accepted: true } });
    await untilConnected();
    const out = await cmd<{ ok: boolean; detail: string }>("health.fix", { id: `root:${dir}/Work` });
    expect(out.body.ok).toBe(true);
    expect(out.body.detail).toContain("restarting");
    expect(helper?.seen.map((j) => j.method)).toEqual(["remount"]);
  });

  it("tells the owner the one command when a remount cannot be done", async () => {
    const out = await cmd<{ ok: boolean; detail: string }>("health.fix", { id: `root:${dir}/Work` });
    expect(out.body).toMatchObject({ ok: false, detail: expect.stringContaining("make up") });
  });

  it("fixes SSH by reloading the keys through the helper", async () => {
    startHelper(INFO, { "ssh.reload": SSH });
    await untilConnected();
    const out = await cmd("health.fix", { id: "ssh-agent" });
    expect(out.body).toEqual({ ok: true, detail: "Loaded your SSH keys (2 in the agent)." });
    expect(helper?.seen.map((j) => j.method)).toEqual(["ssh.reload"]);
  });

  it("restarts the helper link on request, and refuses an unknown fix", async () => {
    startHelper({ ...INFO, canRemount: false }, { restart: { accepted: true } });
    await untilConnected();
    expect(byId(await checks(), "host-helper")?.fix).toEqual({ label: "Restart helper" });
    expect((await cmd("health.fix", { id: "host-helper" })).body).toMatchObject({ ok: true });
    expect((await cmd("health.fix", { id: "nonsense" })).body).toEqual({
      ok: false,
      detail: "majhi has no fix for this check.",
    });
  });

  it("reports a stale sign-in and offers the sign-in terminal for it", async () => {
    // No account exists in this fixture, so an unknown one is refused in plain words.
    expect((await cmd("health.fix", { id: "account:ghost" })).body).toEqual({
      ok: false,
      detail: "There is no account ghost.",
    });
  });

  it("system.version lists the commits between the running image and the checkout", async () => {
    startHelper(INFO, {
      "version.changes": { head: ON_DISK, dirty: true, changes: ["feat(x): two", "fix(y): one"] },
    });
    await untilConnected();
    const out = await cmd<CommandOutput<"system.version">>("system.version");
    expect(out.body).toMatchObject({
      running: RUNNING,
      onDisk: ON_DISK,
      updateReady: true,
      changes: ["feat(x): two", "fix(y): one"],
      dirty: true,
      canUpdate: true,
    });
    expect(helper?.seen[0]).toMatchObject({ method: "version.changes", params: { from: RUNNING } });
  });

  it("system.version says nothing is ready when the commits match or the image has no commit", async () => {
    startHelper({ ...INFO, commit: RUNNING }, {});
    await untilConnected();
    expect((await cmd<CommandOutput<"system.version">>("system.version")).body).toMatchObject({
      updateReady: false,
      changes: [],
    });
    const env = testEnv(dir, { commit: "dev" });
    const dev = createMajhiApp(env, { hostLink: link, runtime: fakeRuntime() });
    const res = await dev.request("/api/cmd/system.version", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(await res.json()).toMatchObject({ running: "dev", updateReady: false });
  });

  it("system.version carries the helper's update progress from update.json", async () => {
    await writeFile(
      join(dir, ".majhi", "update.json"),
      JSON.stringify({
        state: "running",
        commit: ON_DISK,
        startedAt: "2026-09-30T10:00:00.000Z",
        lines: ["Building"],
      }),
    );
    const out = await cmd<CommandOutput<"system.version">>("system.version");
    expect(out.body.update).toMatchObject({ state: "running", lines: ["Building"] });
    expect(out.body.onDisk).toBeUndefined();
  });

  it("system.update asks the helper to rebuild, and falls back to make up only when it cannot", async () => {
    expect((await cmd("system.update")).body).toMatchObject({
      state: "manual",
      reason: expect.stringContaining("make up"),
    });

    startHelper(INFO, { update: { accepted: true } });
    await untilConnected();
    expect((await cmd("system.update")).body).toEqual({ state: "restarting" });
    expect(helper?.seen.map((j) => j.method)).toEqual(["update"]);
  });

  it("system.update relays the helper's refusal", async () => {
    startHelper(INFO, { update: new Error("An update is already running.") });
    await untilConnected();
    expect((await cmd("system.update")).body).toEqual({
      state: "manual",
      reason: "An update is already running.",
    });
  });
});

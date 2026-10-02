import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloneTempPath } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { tempDir } from "../testing/fixtures.ts";
import { CloneRepo, RESTARTED } from "./cloneJobs.ts";

let cleanup: (() => Promise<void>) | undefined;
let store: Store | undefined;
afterEach(async () => {
  store?.close();
  await cleanup?.();
  store = undefined;
  cleanup = undefined;
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function setup() {
  const t = await tempDir();
  cleanup = t.cleanup;
  store = new Store(join(t.dir, "majhi.db"));
  let now = Date.parse("2026-10-02T10:00:00Z");
  const repo = new CloneRepo(store.raw, () => now);
  const root = join(t.dir, "Work");
  const job = (id: string, folder: string, createdFolder: boolean) =>
    repo.insert({
      id,
      org: "acme",
      kind: "github",
      host: "github.com",
      fullName: `acme/${folder}`,
      root,
      path: join(root, "acme", folder),
      project: folder,
      createdFolder,
    });
  return { repo, root, job, tick: (ms: number) => (now += ms) };
}

describe("clone jobs", () => {
  it("moves forward only, and an ended job never changes", async () => {
    const s = await setup();
    const id = "cl_AAAAAAAAAAAAAAAA";
    expect(s.job(id, "api", true).state).toBe("queued");
    s.repo.progress(id, "receiving", 40);
    expect(s.repo.get(id)).toMatchObject({ state: "cloning", phase: "receiving", percent: 40 });
    s.repo.registering(id);
    s.repo.progress(id, "receiving", 90);
    expect(s.repo.get(id)?.state).toBe("registering");
    s.repo.done(id, "main");
    s.repo.failed(id, "late");
    expect(s.repo.get(id)).toMatchObject({ state: "done", base: "main" });
  });

  it("lists running jobs and those that ended within the hour, newest first", async () => {
    const s = await setup();
    s.job("cl_AAAAAAAAAAAAAAA1", "one", true);
    s.repo.failed("cl_AAAAAAAAAAAAAAA1", "no");
    s.tick(1000);
    s.job("cl_AAAAAAAAAAAAAAA2", "two", true);
    expect(s.repo.list().map((j) => j.clone)).toEqual(["cl_AAAAAAAAAAAAAAA2", "cl_AAAAAAAAAAAAAAA1"]);
    s.tick(60 * 60_000);
    expect(s.repo.list().map((j) => j.clone)).toEqual(["cl_AAAAAAAAAAAAAAA2"]);
  });

  it("after a restart: fails cut-off jobs, removes only folders majhi made inside the root", async () => {
    const s = await setup();
    const made = s.job("cl_MADEMADEMADEMADE", "made", true);
    const kept = s.job("cl_KEPTKEPTKEPTKEPT", "kept", false);
    const reg = s.job("cl_REGSREGSREGSREGS", "reg", true);
    for (const j of [made, kept]) {
      await mkdir(cloneTempPath(j.path, j.clone), { recursive: true });
      await mkdir(j.path, { recursive: true });
      await writeFile(join(j.path, "half"), "x");
    }
    await mkdir(reg.path, { recursive: true });
    const n = await s.repo.recover((path) => (path === reg.path ? "reg" : undefined));
    expect(n).toBe(3);
    expect(s.repo.get(made.clone)).toMatchObject({ state: "failed", reason: RESTARTED });
    expect(await exists(made.path)).toBe(false);
    expect(await exists(cloneTempPath(made.path, made.clone))).toBe(false);
    // The folder was there before the job: majhi leaves it.
    expect(s.repo.get(kept.clone)?.state).toBe("failed");
    expect(await exists(kept.path)).toBe(true);
    expect(await exists(cloneTempPath(kept.path, kept.clone))).toBe(false);
    // Registered before the restart: done, folder kept.
    expect(s.repo.get(reg.clone)?.state).toBe("done");
    expect(await exists(reg.path)).toBe(true);
  });

  it("never removes a path outside the job's root", async () => {
    const s = await setup();
    const outside = join(s.root, "..", "Elsewhere", "api");
    await mkdir(outside, { recursive: true });
    s.repo.insert({
      id: "cl_OUTSIDEOUTSIDEOU",
      org: "acme",
      kind: "github",
      host: "github.com",
      fullName: "acme/api",
      root: s.root,
      path: outside,
      project: "api",
      createdFolder: true,
    });
    await s.repo.recover(() => undefined);
    expect(await exists(outside)).toBe(true);
  });
});

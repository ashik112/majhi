import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readMounts } from "../runs/launch.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { blockedPaths, checkReadMount, projectsFor, type ReadPolicy, ReadRefused } from "./read-mounts.ts";

let w: World;
afterEach(() => w?.cleanup());

const must = async (name: string, body: unknown) => {
  const res = await w.h.cmd(name, body);
  if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
  return res.body;
};

async function policyFor(scope: string): Promise<ReadPolicy> {
  const home = w.h.dir;
  return {
    roots: [join(home, "Work")],
    projects: [
      { path: w.repo("api"), org: "acme" },
      { path: w.repo("ledger"), org: "globex" },
    ],
    scope,
    blocked: blockedPaths({
      majhiHome: join(home, ".majhi"),
      hostHome: home,
      protectedPaths: [join(home, "secrets.key")],
    }),
    tasksDir: join(home, "Work", ".majhi"),
  };
}

async function readWorld() {
  w = await taskWorld();
  await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
  await w.addRepo("ledger");
  await must("projects.register", { id: "globex-ledger", org: "globex", path: "~/Work/ledger" });
  await mkdir(join(w.h.dir, "Work", "notes"), { recursive: true });
  await mkdir(join(w.h.dir, "outside"), { recursive: true });
  await symlink(join(w.h.dir, "outside"), join(w.h.dir, "Work", "escape"));
  await mkdir(join(w.h.dir, ".majhi"), { recursive: true });
  await mkdir(join(w.h.dir, ".ssh"), { recursive: true });
  await mkdir(join(w.h.dir, "Work", ".majhi"), { recursive: true });
}

describe("which folders an agent may read", () => {
  it("lets an org agent read its own org's projects and unregistered folders under the roots", async () => {
    await readWorld();
    const acme = await policyFor("acme");
    expect(await checkReadMount(w.repo("api"), acme)).toBe(w.repo("api"));
    expect(await checkReadMount(join(w.repo("api"), "README.md"), acme)).toBe(
      join(w.repo("api"), "README.md"),
    );
    expect(await checkReadMount(join(w.h.dir, "Work", "notes"), acme)).toBe(join(w.h.dir, "Work", "notes"));
  });

  it("refuses paths outside the roots, majhi's home, the owner's ssh keys and the secrets key", async () => {
    await readWorld();
    const root = await policyFor("root");
    await writeFile(join(w.h.dir, "secrets.key"), "k");
    for (const bad of [
      join(w.h.dir, "outside"),
      join(w.h.dir, ".majhi"),
      join(w.h.dir, ".ssh"),
      w.h.dir,
      "relative/path",
      join(w.h.dir, "Work", "missing"),
    ]) {
      await expect(checkReadMount(bad, root), bad).rejects.toBeInstanceOf(ReadRefused);
    }
    // A root agent may hold a root that contains the secrets key only when it is not inside it.
    const wide = { ...root, roots: [w.h.dir] };
    await expect(checkReadMount(w.h.dir, wide)).rejects.toBeInstanceOf(ReadRefused);
    await expect(checkReadMount(join(w.h.dir, "secrets.key"), wide)).rejects.toBeInstanceOf(ReadRefused);
  });

  it("refuses a link that leads outside the roots", async () => {
    await readWorld();
    for (const scope of ["acme", "root"]) {
      await expect(checkReadMount(join(w.h.dir, "Work", "escape"), await policyFor(scope))).rejects.toThrow(
        /outside the workspace roots/,
      );
    }
  });

  it("refuses another org's project, and a folder holding it, for an org agent only", async () => {
    await readWorld();
    const acme = await policyFor("acme");
    await expect(checkReadMount(w.repo("ledger"), acme)).rejects.toThrow(/another org's project/);
    await expect(checkReadMount(join(w.repo("ledger"), "README.md"), acme)).rejects.toBeInstanceOf(
      ReadRefused,
    );
    await expect(checkReadMount(join(w.h.dir, "Work"), acme)).rejects.toBeInstanceOf(ReadRefused);
    await expect(checkReadMount(join(w.h.dir, "Work", ".majhi"), acme)).rejects.toBeInstanceOf(ReadRefused);
    const root = await policyFor("root");
    expect(await checkReadMount(w.repo("ledger"), root)).toBe(w.repo("ledger"));
  });
});

describe("registered projects in every run", () => {
  const projects = [
    { id: "acme-api", org: "acme" },
    { id: "globex-ledger", org: "globex" },
  ];

  it("gives a root agent every project and an org agent only its own org's", () => {
    expect(projectsFor("root", projects).map((p) => p.id)).toEqual(["acme-api", "globex-ledger"]);
    expect(projectsFor("acme", projects).map((p) => p.id)).toEqual(["acme-api"]);
    expect(projectsFor("initech", projects)).toEqual([]);
  });
});

describe("run read mounts", () => {
  it("mounts task output read-only for root, and never for an org agent", async () => {
    await readWorld();
    const task = (await must("tasks.create", {
      text: "inspect api",
      repos: [{ project: "acme-api", base: "main" }],
      start: false,
    })) as Task;
    const services = w.h.majhi.services;
    const deps = { config: services.config, majhiHome: w.h.env.majhiHome, secrets: services.secrets };
    const loaded = await services.config.load();
    if (loaded.state.status !== "loaded") throw new Error("no config");
    const tasks = loaded.state.config.tasksDir;
    expect(await readMounts(deps, task, "boss", "root")).toContainEqual({ path: tasks, readOnly: true });
    expect((await readMounts(deps, task, "acme-builder", "acme")).some((m) => m.path === tasks)).toBe(false);
  });
});

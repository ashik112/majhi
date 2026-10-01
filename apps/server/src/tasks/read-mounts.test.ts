import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runMounts } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
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

describe("read-only mounts at run start", () => {
  it("are passed read-only to the runner, and its guard still refuses majhi's home", () => {
    type Req = Parameters<typeof runMounts>[0];
    const cfg = {
      majhiHome: "/Users/owner/.majhi",
      protectedPaths: [],
      image: "img",
      cliEnv: {},
    } as unknown as Parameters<typeof runMounts>[1];
    const req = (mounts: { path: string; readOnly?: boolean }[]) =>
      ({
        cwd: "/Users/owner/Work/.majhi/ACM-1",
        env: {},
        command: { command: "x", args: [] },
        mounts,
      }) as unknown as Req;
    const mounts = runMounts(req([{ path: "/Users/owner/Work/acme/api", readOnly: true }]), cfg);
    expect(mounts).toContainEqual({ path: "/Users/owner/Work/acme/api", readOnly: true });
    expect(() => runMounts(req([{ path: "/Users/owner/.majhi", readOnly: true }]), cfg)).toThrow();
  });
});

describe("an agent reads the folder a message mentions", () => {
  it("mounts it read-only for that agent and says so in the room", async () => {
    await readWorld();
    await w.addRepo("billing");
    await must("tasks.create", { text: "look at the api repo", readOnly: true, start: false });
    const asked = `why does @${w.repo("billing")} fail? Also @${w.repo("ledger")} and @${join(w.h.dir, "outside")}.`;
    await must("room.send", { task: "ACM-1", text: asked });
    // The send returns at once; the grants come with its delivery.
    await w.h.majhi.services.runs.idle("ACM-1");
    const task = (await must("tasks.get", { id: "ACM-1" })) as {
      readMounts?: { path: string; agent?: string }[];
    };
    expect(task.readMounts?.map((m) => [m.path, m.agent])).toEqual([
      [w.repo("api"), undefined],
      [w.repo("billing"), "acme-builder"],
    ]);
    const page = (await must("room.items", { task: "ACM-1", limit: 100 })) as { items: RoomItem[] };
    const lines = page.items.flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(lines).toContain(`@acme-builder can now read ${w.repo("billing")} (read-only).`);
    expect(lines.some((l) => l.includes(w.repo("ledger")) && l.includes("cannot read"))).toBe(true);
    expect(lines.some((l) => l.includes("outside") && l.includes("cannot read"))).toBe(true);
    const start = w.h.runtime.starts.at(-1);
    expect(start?.mounts).toContainEqual({ path: w.repo("billing"), readOnly: true });
  });
});

describe("an investigation task", () => {
  it("mounts the repo read-only and makes no branch, no worktree and no ship options", async () => {
    await readWorld();
    const created = (await must("tasks.create", {
      text: "why does the api health check fail? repo api",
      readOnly: true,
      start: true,
    })) as { id: string; kind: string; repos: unknown[]; readMounts?: { path: string }[] };
    expect(created.kind).toBe("ops");
    expect(created.repos).toEqual([]);
    expect(created.readMounts?.map((m) => m.path)).toEqual([w.repo("api")]);
    await w.h.majhi.services.runs.idle(created.id);
    const branches = await git(w.repo("api"), "branch", "--list");
    expect(branches).not.toMatch(/majhi|ACM-/);
    const trees = await git(w.repo("api"), "worktree", "list");
    expect(trees.trim().split("\n")).toHaveLength(1);
    expect(w.h.runtime.starts.at(-1)?.mounts).toContainEqual({ path: w.repo("api"), readOnly: true });
    const options = (await must("tasks.shipOptions", { id: created.id })) as Record<string, { ok: boolean }>;
    for (const key of ["merge", "mergePush", "push", "mr"]) expect(options[key]?.ok, key).toBe(false);
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

  it("mounts them read-only into an org agent's run, never another org's, and into a root agent's run all", async () => {
    await readWorld();
    await must("agents.create", {
      id: "boss",
      frontmatter: { scope: "root", role: "Root", account: "claude-acme", perms: ["shell"] },
      instructions: "Run things.\n",
    });
    await must("tasks.create", { text: "look at the api repo", readOnly: true, start: true });
    await w.h.majhi.services.runs.idle("ACM-1");
    const own = w.h.runtime.starts.at(-1)?.mounts ?? [];
    expect(own).toContainEqual({ path: w.repo("api"), readOnly: true });
    expect(own.map((m) => m.path)).not.toContain(w.repo("ledger"));
    // The task's own folder is not a mount here: the runner adds it, read-write.
    expect(own.every((m) => m.readOnly === true || m.path.endsWith(".git"))).toBe(true);

    await must("tasks.create", { text: "look around as the boss", kind: "chat", agent: "boss", start: true });
    await w.h.majhi.services.runs.idle();
    expect(w.h.runtime.starts.at(-1)?.mounts).toBeDefined();
    const boss = w.h.runtime.starts.at(-1)?.mounts ?? [];
    expect(boss).toContainEqual({ path: w.repo("api"), readOnly: true });
    expect(boss).toContainEqual({ path: w.repo("ledger"), readOnly: true });
  });
});

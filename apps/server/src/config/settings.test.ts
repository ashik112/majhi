import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";

let h: Harness;
afterEach(() => h?.cleanup());

describe("update-target approval migration", () => {
  it("turns a stored confirm for tasks.updateTarget into auto, keeps every other override, and runs once", async () => {
    h = await harness();
    const service = h.majhi.services.config;
    const change = { command: "policy.set", meta: { actor: { kind: "owner" } }, summary: "test" } as const;
    await service.setSettings(
      { policy: { commands: { "tasks.updateTarget": "confirm", "tasks.merge": "confirm" } } },
      change,
    );
    expect(await service.migrateUpdateTargetPolicy()).toBe(true);
    expect((await service.settings()).policy.commands).toEqual({
      "tasks.updateTarget": "auto",
      "tasks.merge": "confirm",
    });
    expect(await service.migrateUpdateTargetPolicy()).toBe(false);
    // An owner's own choice other than the old preset value stays.
    await service.setSettings({ policy: { commands: { "tasks.updateTarget": "when-asked" } } }, change);
    expect(await service.migrateUpdateTargetPolicy()).toBe(false);
    expect((await service.settings()).policy.commands).toEqual({ "tasks.updateTarget": "when-asked" });
  });
});

describe("settings commands", () => {
  it("saves weekly budgets to majhi.yaml, merges one at a time, removes with null, and refuses bad ones", async () => {
    h = await harness();
    const set = await h.cmd("settings.set", {
      budgets: { orgs: { acme: { tokens: 5_000_000 } }, accounts: { "claude-acme": { cost: 40 } } },
    });
    expect(set.status).toBe(200);
    expect(set.body.budgets).toEqual({
      orgs: { acme: { tokens: 5_000_000 } },
      accounts: { "claude-acme": { cost: 40 } },
    });
    // Another org is added, and the rest stay.
    const more = await h.cmd("settings.set", { budgets: { orgs: { globex: { tokens: 1000, cost: 5 } } } });
    expect(more.body.budgets.orgs).toEqual({
      acme: { tokens: 5_000_000 },
      globex: { tokens: 1000, cost: 5 },
    });
    expect(more.body.budgets.accounts).toEqual({ "claude-acme": { cost: 40 } });
    const yaml = await readFile(h.majhi.services.config.file, "utf8");
    expect(yaml).toContain("budgets:");
    expect(yaml).toContain("tokens: 5000000");
    // The file as a whole still loads: majhi.yaml's own schema knows the section.
    expect((await h.majhi.services.config.load()).state.status).toBe("loaded");
    expect((await h.cmd("settings.get")).body.budgets).toEqual(more.body.budgets);
    const gone = await h.cmd("settings.set", { budgets: { orgs: { acme: null, globex: null } } });
    expect(gone.body.budgets.orgs).toEqual({});
    expect(await readFile(h.majhi.services.config.file, "utf8")).not.toContain("globex");
    expect((await h.cmd("settings.set", { budgets: { orgs: { acme: { tokens: 0 } } } })).status).toBe(400);
    expect((await h.cmd("settings.set", { budgets: { orgs: { acme: { gold: 1 } } } })).status).toBe(400);
    expect((await h.cmd("settings.set", { budgets: { orgs: { "Not An Id": { tokens: 5 } } } })).status).toBe(
      400,
    );
  });

  it("sets the container limits but never the image list, which only its own command changes", async () => {
    h = await harness();
    const set = await h.cmd("settings.set", { containers: { cpus: 0.5, memory: "512m", per_task: 2 } });
    expect(set.status).toBe(200);
    expect(set.body.containers).toMatchObject({ cpus: 0.5, memory: "512m", per_task: 2, images: [] });
    expect(await readFile(h.majhi.services.config.file, "utf8")).toContain("memory: 512m");
    expect((await h.cmd("settings.set", { containers: { images: ["postgres:16-alpine"] } })).status).toBe(
      400,
    );
    expect((await h.cmd("settings.set", { containers: { memory: "lots" } })).status).toBe(400);
    expect((await h.cmd("settings.set", { containers: { per_task: 11 } })).status).toBe(400);
    // A hand-written list in majhi.yaml is read.
    const file = h.majhi.services.config.file;
    await writeFile(file, `${await readFile(file, "utf8")}  images: [postgres:16-alpine]\n`);
    expect((await h.cmd("settings.get")).body.containers.images).toEqual(["postgres:16-alpine"]);
  });

  it("reports invalid settings written by hand", async () => {
    h = await harness();
    const file = h.majhi.services.config.file;
    await writeFile(file, `${await readFile(file, "utf8")}limits:\n  agents_max: lots\n`);
    const res = await h.cmd("settings.get");
    expect(res.status).toBe(409);
    expect(res.body.details.join(" ")).toContain("agents_max");
  });

  it("refuses before majhi.yaml exists", async () => {
    h = await harness({ workspaces: false });
    expect((await h.cmd("settings.get")).status).toBe(200);
    expect((await h.cmd("settings.set", { resume: { auto: false } })).status).toBe(409);
  });
});

import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";
import { mergeSettings } from "./settings.ts";

let h: Harness;
afterEach(() => h?.cleanup());

describe("mergeSettings", () => {
  it("fills every default", () => {
    expect(mergeSettings({})).toEqual({
      context: { cap: 200_000, compact_at: 0.8, compact_target: 0.4, max_turns: 40 },
      limits: { agents_max: 6, per_account: 2, per_task: 3, idle_timeout: "3m" },
      turns: { max_length: "2h", idle: "25m", max_tool_calls: 0 },
      resume: { auto: true, handoff: true },
      commits: { attribution: true },
      rooms: { max_agent_turns: 12, review_rounds: 5 },
      policy: {
        read: "auto",
        change: "when-asked",
        destructive: "confirm",
        outbound: "confirm",
        commands: {},
        rules: [],
        allow_destructive_rules: false,
      },
      memory: { auto_threshold: 0.4, review_all: false, chat_idle_minutes: 30 },
      editor: { app: "vscode" },
      cleanup: { after_days: 30, caches_after_days: 1, free_after_hours: 24, worktree_after_days: 7 },
      notifications: { mac: true, browser: true, sound: false, muted: [] },
      containers: {
        images: [],
        cpus: 1,
        memory: "512m",
        per_task: 3,
        total: 8,
        build_total: 1,
        build_cpus: 2,
        build_memory: "4g",
      },
      budgets: { orgs: {}, accounts: {} },
      autonomy: {
        day: { cost: 20 },
        orgs: {},
        floors: { window: 10, weekly: 5 },
        summary_at: "08:00",
        instructions: [],
        pick: { size: "any" },
      },
    });
  });

  it("keeps what the file sets and defaults the rest", () => {
    const merged = mergeSettings({ limits: { agents_max: 3 }, policy: { change: "confirm" } });
    expect(merged.limits).toEqual({ agents_max: 3, per_account: 2, per_task: 3, idle_timeout: "3m" });
    expect(merged.policy.change).toBe("confirm");
    expect(merged.policy.read).toBe("auto");
  });

  it("keeps an owner's own idle timeout and container memory over the smaller defaults", () => {
    const merged = mergeSettings({ limits: { idle_timeout: "10m" }, containers: { memory: "2g" } });
    expect(merged.limits.idle_timeout).toBe("10m");
    expect(merged.containers.memory).toBe("2g");
  });
});

describe("settings commands", () => {
  it("rejects bad values with details", async () => {
    h = await harness();
    const bad = await h.cmd("settings.set", { limits: { agents_max: 0 }, context: { compact_at: 2 } });
    expect(bad.status).toBe(400);
    expect(bad.body.details.join(" ")).toContain("agents_max");
    const idle = await h.cmd("settings.set", { limits: { idle_timeout: "soon" } });
    expect(idle.status).toBe(400);
    const order = await h.cmd("settings.set", { context: { compact_at: 0.3 } });
    expect(order.status).toBe(400);
    expect(order.body.error).toContain("compact_target must be lower");
    const unknown = await h.cmd("settings.set", { limits: { nope: 1 } });
    expect(unknown.status).toBe(400);
  });

  it("saves the editor choice to majhi.yaml, reads it back, and refuses an unknown editor", async () => {
    h = await harness();
    expect((await h.cmd("settings.get", {})).body.editor).toEqual({ app: "vscode" });
    const set = await h.cmd("settings.set", { editor: { app: "cursor" } });
    expect(set.status).toBe(200);
    expect(set.body.editor).toEqual({ app: "cursor" });
    expect((await h.cmd("settings.get", {})).body.editor).toEqual({ app: "cursor" });
    expect(await readFile(h.majhi.services.config.file, "utf8")).toContain("app: cursor");
    expect((await h.cmd("settings.set", { editor: { app: "vim" } })).status).toBe(400);
  });

  it("changes the memory section, keeps the rest of it, and refuses bad values and unknown agents", async () => {
    h = await harness();
    const set = await h.cmd("settings.set", { memory: { auto_threshold: 0.9, review_all: true } });
    expect(set.status).toBe(200);
    expect(set.body.memory).toEqual({ auto_threshold: 0.9, review_all: true, chat_idle_minutes: 30 });
    const again = await h.cmd("settings.set", { memory: { housekeeper_model: "a-small-model" } });
    expect(again.body.memory).toEqual({
      auto_threshold: 0.9,
      review_all: true,
      chat_idle_minutes: 30,
      housekeeper_model: "a-small-model",
    });
    expect(await readFile(h.majhi.services.config.file, "utf8")).toContain("auto_threshold: 0.9");
    // null puts a default back: no model set means the cheapest one.
    const cleared = await h.cmd("settings.set", { memory: { housekeeper_model: null } });
    expect(cleared.body.memory).toEqual({ auto_threshold: 0.9, review_all: true, chat_idle_minutes: 30 });
    expect(await readFile(h.majhi.services.config.file, "utf8")).not.toContain("housekeeper_model");
    expect((await h.cmd("settings.set", { memory: { auto_threshold: 1.5 } })).status).toBe(400);
    expect((await h.cmd("settings.set", { memory: { housekeeper: "nobody" } })).status).toBe(404);
    expect((await h.cmd("settings.set", { memory: { nope: 1 } })).status).toBe(400);
  });

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

  it("turns agent attribution off for majhi, and back to the default", async () => {
    h = await harness();
    expect((await h.cmd("settings.get")).body.commits).toEqual({ attribution: true });
    const off = await h.cmd("settings.set", { commits: { attribution: false } });
    expect(off.status).toBe(200);
    expect(off.body.commits).toEqual({ attribution: false });
    expect(await readFile(h.majhi.services.config.file, "utf8")).toContain("attribution: false");
    // The file still loads: the section is part of the schema.
    expect((await h.cmd("settings.get")).body.commits).toEqual({ attribution: false });
    expect((await h.cmd("settings.set", { commits: { nope: 1 } })).status).toBe(400);
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
    expect((await h.cmd("settings.get")).body.context.compact_at).toBe(0.8);
    expect((await h.cmd("settings.set", { resume: { auto: false } })).status).toBe(409);
  });
});

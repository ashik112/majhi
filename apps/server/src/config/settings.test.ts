import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";
import { mergeSettings } from "./settings.ts";

let h: Harness;
afterEach(() => h?.cleanup());

describe("mergeSettings", () => {
  it("fills every default", () => {
    expect(mergeSettings({})).toEqual({
      context: { compact_at: 0.8, compact_target: 0.4, max_turns: 40 },
      limits: { agents_max: 6, per_account: 2, per_task: 3, idle_timeout: "10m" },
      resume: { auto: true },
      policy: {
        read: "auto",
        change: "when-asked",
        destructive: "confirm",
        outbound: "confirm",
        commands: {},
      },
    });
  });

  it("keeps what the file sets and defaults the rest", () => {
    const merged = mergeSettings({ limits: { agents_max: 3 }, policy: { change: "confirm" } });
    expect(merged.limits).toEqual({ agents_max: 3, per_account: 2, per_task: 3, idle_timeout: "10m" });
    expect(merged.policy.change).toBe("confirm");
    expect(merged.policy.read).toBe("auto");
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

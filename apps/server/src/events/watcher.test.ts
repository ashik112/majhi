import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerEvent } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { EventHub, topicsFor } from "./hub.ts";
import { HomeWatcher } from "./watcher.ts";

describe("HomeWatcher", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let home: string;
  let hub: EventHub;
  let events: ServerEvent[];
  let watcher: HomeWatcher;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    home = join(dir, ".majhi");
    hub = new EventHub();
    events = [];
    hub.subscribe((e) => events.push(e));
    watcher = new HomeWatcher(home, hub, 150);
  });
  afterEach(async () => {
    watcher.stop();
    await cleanup();
  });

  const topics = () => new Set(events.flatMap((e) => (e.type === "changed" ? e.topics : [])));
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(check()).toBe(true);
  };

  it("emits when majhi.yaml is edited by hand", async () => {
    await mkdir(home, { recursive: true });
    watcher.start();
    await writeFile(join(home, "majhi.yaml"), "workspaces: [~/Work]\n");
    await until(() => topics().has("config"));
    expect(topics()).toEqual(new Set(["config", "orgs", "accounts", "agents"]));
  });

  it("emits for agent files, even when the folder does not exist yet", async () => {
    watcher.start(); // majhi home itself is missing
    await mkdir(join(home, "agents"), { recursive: true });
    await until(() => topics().has("agents"));
    events.length = 0;

    await writeFile(join(home, "agents", "builder.md"), "---\nid: builder\n---\n");
    await until(() => topics().has("agents"));
    expect(topics()).toEqual(new Set(["agents"]));
  });

  it("ignores other files and merges a burst into one event", async () => {
    await mkdir(join(home, "agents"), { recursive: true });
    await new Promise((r) => setTimeout(r, 200)); // macOS reports events from just before the watch starts
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));
    events.length = 0;
    await writeFile(join(home, "notes.txt"), "x");
    await writeFile(join(home, "agents", "a.md.123.tmp"), "x");
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual([]);

    await writeFile(join(home, "agents", "a.md"), "1");
    await writeFile(join(home, "agents", "b.md"), "2");
    await until(() => events.length > 0);
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual([{ type: "changed", topics: ["agents"] }]);
  });
});

describe("topicsFor", () => {
  it("maps commands to topics", () => {
    expect(topicsFor("accounts.create")).toEqual(["accounts", "config"]);
    expect(topicsFor("agents.update")).toEqual(["agents"]);
    expect(topicsFor("boss.set")).toEqual(["agents", "config"]);
    expect(topicsFor("orgs.create")).toEqual(["orgs", "config"]);
    expect(topicsFor("fs.listDirs")).toEqual([]);
  });
});

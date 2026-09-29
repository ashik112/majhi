import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startSession } from "@majhi/acp";
import { fakeAdapter } from "@majhi/acp/testing";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

/** A world whose sessions run the real ACP engine against the fake adapter. */
async function realWorld(slowMs = 0): Promise<World> {
  w = await taskWorld();
  w.h.env.runtime.adapters = { claude: fakeAdapter("claude", { signedIn: true, slowMs }) };
  w.h.runtime.startSession = (start) => startSession(start);
  return w;
}

async function items(): Promise<RoomItem[]> {
  const page = await w.h.cmd("room.items", { task: "ACM-1", limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}

const live = () => w.h.majhi.services.room.getLive("ACM-1", "acme-builder");

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

describe("the run manager with the fake ACP adapter", () => {
  it("runs the default turn of a new task and writes into the worktree on the next message", async () => {
    await realWorld();
    const created = await w.h.cmd("tasks.create", {
      text: "add a health endpoint to api from develop",
      start: true,
    });
    expect(created.status).toBe(200);
    const folder = created.body.folder as string;
    await w.h.majhi.services.runs.idle();

    const first = await items();
    const kinds = first.map((i) => i.type);
    expect(kinds.filter((k) => k === "permission")).toHaveLength(1);
    const notices = first.flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(notices).toContain("Unknown model: sonnet. Keeping the default model (fake-model-a).");
    expect(notices.some((t) => t.startsWith("@acme-builder started on claude-acme, model "))).toBe(true);
    const tools = first.filter((i) => i.type === "tool") as Extract<RoomItem, { type: "tool" }>[];
    expect(tools.map((t) => [t.toolCallId, t.kind, t.status])).toEqual([
      ["t-read", "read", "completed"],
      ["t-edit", "edit", "completed"],
      ["t-exec", "execute", "completed"],
    ]);
    expect(tools[1]?.content[0]).toMatchObject({ type: "diff", newText: "# Health\n\nok\n" });
    expect(first.find((i) => i.type === "permission")).toMatchObject({
      state: "auto",
      chosen: "allow",
      title: "Run npm test",
    });
    expect(first.filter((i) => i.type === "plan")).toHaveLength(1);
    const agentText = first.filter((i) => i.type === "agent").map((i) => (i as { text: string }).text);
    expect(agentText[0]).toBe("I will look at the project first. ");
    expect(agentText.at(-1)).toContain("Created HEALTH.md.");
    expect(await readFile(join(folder, "HEALTH.md"), "utf8")).toBe("# Health\n\nok\n");
    expect(live()).toMatchObject({ status: "idle", commands: [{ name: "compact" }, { name: "review" }] });
    expect(live()?.usage?.size).toBe(200000);
    expect(w.h.majhi.services.store.permissions.audit("ACM-1")).toMatchObject([
      { kind: "execute", by: "rule", decision: "allow" },
    ]);

    // A second message writes a file inside the worktree, on the task branch.
    const sent = await w.h.cmd("room.send", { task: "ACM-1", text: "please create acme-api/health.txt" });
    expect(sent.status).toBe(200);
    await w.h.majhi.services.runs.idle();
    const worktree = join(folder, "acme-api");
    expect(existsSync(join(worktree, "health.txt"))).toBe(true);
    expect(await git(worktree, "status", "--porcelain")).toBe("?? health.txt");
    expect(await git(worktree, "symbolic-ref", "--short", "HEAD")).toBe(
      "task/acm-1-add-a-health-endpoint-to-api",
    );
    // Nothing was pushed.
    expect(await git(w.remote("api"), "for-each-ref", "--format=%(refname)")).toBe(
      "refs/heads/develop\nrefs/heads/main",
    );
  });

  it("stops a slow turn with cancel and leaves the agent idle", async () => {
    await realWorld(150);
    await w.h.cmd("tasks.create", { text: "fix api", start: true });
    await until(() => live()?.status === "working", "the agent to work");
    const res = await w.h.cmd("room.cancel", { task: "ACM-1" });
    expect(res.body).toEqual({ cancelled: ["acme-builder"] });
    await w.h.majhi.services.runs.idle();
    expect(live()?.status).toBe("idle");
    const texts = (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(texts).toContain("Stopped @acme-builder's turn.");
  });

  it("asks the owner when the agent has no shell permission", async () => {
    w = await taskWorld({ agent: { perms: ["edit"] } });
    w.h.env.runtime.adapters = { claude: fakeAdapter("claude", { signedIn: true }) };
    w.h.runtime.startSession = (start) => startSession(start);
    await w.h.cmd("tasks.create", { text: "fix api", start: true });
    await until(() => live()?.status === "waiting", "the permission prompt");
    const pending = (await items()).find((i) => i.type === "permission") as Extract<
      RoomItem,
      { type: "permission" }
    >;
    expect(pending).toMatchObject({ state: "pending", title: "Run npm test" });
    expect(pending.options.map((o) => o.id)).toEqual(["allow", "allow_always", "reject"]);
    const answered = await w.h.cmd("room.permission", { task: "ACM-1", item: pending.id, option: "reject" });
    expect(answered.body.item).toMatchObject({ state: "answered", chosen: "reject" });
    await w.h.majhi.services.runs.idle();
    const tools = (await items()).filter((i) => i.type === "tool") as Extract<RoomItem, { type: "tool" }>[];
    expect(tools.find((t) => t.toolCallId === "t-exec")?.status).toBe("failed");
  });
});

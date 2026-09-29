import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

const run = promisify(execFile);
let w: BossWorld;
afterEach(() => w?.cleanup());

const KEY = `sk-ant-api03-${"Zq8Lm2".repeat(8)}`;
const GITHUB = `ghp_${"k9J3x7Q2w5".repeat(4)}`;

/** Every byte under the majhi home that is not encrypted, plus the config history. */
async function everythingOnDisk(home: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") await walk(path);
      } else if (entry.name !== "secrets.age") parts.push((await readFile(path)).toString("latin1"));
    }
  };
  await walk(home);
  const { stdout } = await run("git", ["log", "-p", "--all"], { cwd: home });
  parts.push(stdout);
  return parts.join("\n");
}

describe("secrets commands", () => {
  it("saves with a derived name, lists names only, and removes", async () => {
    w = await bossWorld({ real: false });
    const a = await w.h.cmd("secrets.save", { value: KEY });
    expect(a.body).toEqual({ name: "anthropic", ref: "secret:anthropic" });
    expect((await w.h.cmd("secrets.save", { value: `${KEY}2` })).body.name).toBe("anthropic-2");
    expect((await w.h.cmd("secrets.save", { value: GITHUB })).body.name).toBe("github");
    expect(
      (await w.h.cmd("secrets.save", { value: "plain-thing", label: "New Relic (Acme)" })).body.name,
    ).toBe("new-relic-acme");
    expect((await w.h.cmd("secrets.save", { value: "hunter2" })).body.name).toBe("secret-1");
    expect((await w.h.cmd("secrets.save", { name: "mine", value: "v" })).body.ref).toBe("secret:mine");
    expect((await w.h.cmd("secrets.save", { name: "mine", value: "v2" })).status).toBe(409);
    const list = await w.h.cmd("secrets.list");
    expect(list.body.map((s: { name: string }) => s.name)).toEqual([
      "anthropic",
      "anthropic-2",
      "github",
      "mine",
      "new-relic-acme",
      "secret-1",
    ]);
    expect(JSON.stringify(list.body)).not.toContain("hunter2");
    expect((await w.h.cmd("secrets.remove", { name: "mine" })).body).toEqual({ removed: "mine" });
    expect((await w.h.cmd("secrets.remove", { name: "mine" })).status).toBe(404);
  });

  it("refuses to remove a secret that majhi.yaml refers to", async () => {
    w = await bossWorld({ real: false });
    const made = await w.h.cmd("accounts.create", {
      id: "claude-key",
      tool: "claude",
      org: "acme",
      auth: "api-key",
      apiKey: "sk-a-not-a-real-key-1234",
    });
    expect(made.status).toBe(200);
    const res = await w.h.cmd("secrets.remove", { name: "claude-key" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("majhi.yaml");
  });
});

describe("secret capture", () => {
  it("replaces secrets in room.send before the agent or the room see them", async () => {
    w = await bossWorld({ real: false });
    const sent = await w.h.cmd("room.send", {
      task: w.chat.id,
      text: `use ${KEY} for the anthropic account and ${GITHUB} for github, ${KEY} again`,
    });
    expect(sent.status).toBe(200);
    expect(sent.body.item.text).toBe(
      "use secret:anthropic for the anthropic account and secret:github for github, secret:anthropic again",
    );
    await w.h.majhi.services.runs.idle(w.chat.id);
    const items = await w.items();
    const notes = items.flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(notes).toContain("Saved a secret as secret:anthropic; the agent sees only the reference");
    expect(notes).toContain("Saved a secret as secret:github; the agent sees only the reference");

    // What the agent was sent.
    const prompt = JSON.stringify(w.h.runtime.sessions.at(-1)?.prompts);
    expect(prompt).toContain("secret:anthropic");
    for (const value of [KEY, GITHUB]) {
      expect(prompt).not.toContain(value);
      expect(JSON.stringify(items)).not.toContain(value);
      expect(JSON.stringify(sent.body)).not.toContain(value);
    }
    // And it is stored.
    expect(await w.h.majhi.services.secrets.get("anthropic")).toBe(KEY);
    expect(await everythingOnDisk(w.h.env.majhiHome)).not.toContain(KEY.slice(0, 30));
  });

  it("leaves ordinary text alone", async () => {
    w = await bossWorld({ real: false });
    const sent = await w.h.cmd("room.send", {
      task: w.chat.id,
      text: "commit 9fceb02d0ae598e95dc970b74767f19372d61af8 please",
    });
    expect(sent.body.item.text).toContain("9fceb02d0ae598e95dc970b74767f19372d61af8");
    expect(await w.h.majhi.services.secrets.names()).toEqual([]);
  });

  it("refuses to send text with a secret when secrets are not set up", async () => {
    w = await bossWorld({ real: false });
    const { rm } = await import("node:fs/promises");
    await rm(w.h.env.secretsKeyFile);
    const sent = await w.h.cmd("room.send", { task: w.chat.id, text: `here ${KEY}` });
    expect(sent.status).toBe(409);
    expect(JSON.stringify(await w.items())).not.toContain(KEY);
  });

  it("captures a secret in the task text of tasks.create too", async () => {
    w = await bossWorld({ real: false });
    const made = await w.h.cmd("tasks.create", {
      text: `chat about token ${GITHUB}`,
      kind: "chat",
      start: false,
    });
    expect(made.status).toBe(200);
    expect(made.body.brief).toContain("secret:github");
    expect(JSON.stringify(made.body)).not.toContain(GITHUB);
    expect(await readFile(join(made.body.folder, "TASK.md"), "utf8")).not.toContain(GITHUB);
  });
});

describe("secret requests", () => {
  const request = async () => {
    const token = w.h.majhi.services.adminTokens.issue({ task: w.chat.id, agent: "boss" });
    const res = await fetch(w.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "majhi_request_secret",
          arguments: { name: "newrelic-acme", label: "New Relic key" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const card = (await w.items()).find((i) => i.type === "secret-request");
    if (card === undefined) throw new Error("no card");
    return card;
  };

  it("room.secret saves the value, marks the card saved and tells the agent the reference", async () => {
    w = await bossWorld({ real: false });
    const card = await request();
    const value = "nr-live-not-detectable-value-1";
    const res = await w.h.cmd("room.secret", { task: w.chat.id, item: card.id, value });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ state: "saved", name: "newrelic-acme" });
    expect(await w.h.majhi.services.secrets.get("newrelic-acme")).toBe(value);
    await w.h.majhi.services.runs.idle(w.chat.id);
    const items = await w.items();
    expect(items.some((i) => i.type === "owner" && i.text === "Saved as secret:newrelic-acme")).toBe(true);
    expect(JSON.stringify(items)).not.toContain(value);
    expect(JSON.stringify(w.h.runtime.sessions.map((s) => s.prompts))).not.toContain(value);
    expect(await everythingOnDisk(w.h.env.majhiHome)).not.toContain(value);
    // Answering again is refused.
    expect((await w.h.cmd("room.secret", { task: w.chat.id, item: card.id, value })).status).toBe(409);
  });

  it("a rejected request is cancelled and the agent hears it", async () => {
    w = await bossWorld({ real: false });
    const card = await request();
    const res = await w.h.cmd("room.approve", { task: w.chat.id, item: card.id, decision: "reject" });
    expect(res.body.item).toMatchObject({ state: "cancelled" });
    await w.h.majhi.services.runs.idle(w.chat.id);
    expect(
      (await w.items()).some(
        (i) => i.type === "owner" && i.text === "The owner did not provide newrelic-acme.",
      ),
    ).toBe(true);
    expect(await w.h.majhi.services.secrets.names()).toEqual([]);
  });

  it("keeps secrets out of approval cards", async () => {
    w = await bossWorld({ real: false });
    const token = w.h.majhi.services.adminTokens.issue({ task: w.chat.id, agent: "boss" });
    const res = await fetch(w.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "majhi_accounts_create",
          arguments: {
            id: "codex-acme",
            tool: "codex",
            org: "acme",
            auth: "api-key",
            apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz",
            ownerAsked: false,
            reason: "using sk-live-abcdefghijklmnopqrstuvwxyz",
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const items = await w.items();
    expect(JSON.stringify(items)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const card = items.find((i) => i.type === "approval");
    expect(card).toMatchObject({ state: "pending", summary: "Add codex account codex-acme for acme" });
    // Approving runs it with the real key.
    if (card?.type !== "approval") throw new Error("no card");
    const approved = await w.h.cmd("room.approve", { task: w.chat.id, item: card.id, decision: "approve" });
    expect(approved.body.item.state).toBe("applied");
    expect(await w.h.majhi.services.secrets.get("codex-acme")).toBe("sk-live-abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(await w.items())).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(await everythingOnDisk(w.h.env.majhiHome)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

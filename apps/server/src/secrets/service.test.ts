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

describe("secret capture", () => {
  it("replaces secrets in room.send before the agent or the room see them", async () => {
    w = await bossWorld({ real: false });
    const sent = await w.h.cmd("room.send", {
      task: w.chat.id,
      text: `use ${KEY} for the anthropic account and ${GITHUB} for github, ${KEY} again`,
    });
    expect(sent.status).toBe(200);
    expect(sent.body.item.text).toContain("secret:anthropic");
    expect(sent.body.item.text).toContain("secret:github");
    await w.h.majhi.services.runs.idle(w.chat.id);
    const items = await w.items();
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

  it("refuses to send text with a secret when secrets are not set up", async () => {
    w = await bossWorld({ real: false });
    const { rm } = await import("node:fs/promises");
    await rm(w.h.env.secretsKeyFile);
    const sent = await w.h.cmd("room.send", { task: w.chat.id, text: `here ${KEY}` });
    expect(sent.status).toBe(409);
    expect(JSON.stringify(await w.items())).not.toContain(KEY);
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

  it("dismiss resolves the card and tells the agent why, with the reason redacted", async () => {
    w = await bossWorld({ real: false });
    const told: string[] = [];
    w.h.majhi.services.runs.notify = (_task, _agent, text) => {
      told.push(text);
    };
    const card = await request();
    const out = await w.h.cmd("room.approve", {
      task: w.chat.id,
      item: card.id,
      decision: "reject",
      reason: `use the read-only user instead, not ${KEY}`,
    });
    expect(out.body.item).toMatchObject({ type: "secret-request", state: "cancelled" });
    const items = JSON.stringify(await w.items());
    const prompt = told.join("\n");
    expect(prompt).toContain("read-only user");
    for (const text of [items, prompt]) expect(text).not.toContain(KEY);
    expect(await everythingOnDisk(w.h.env.majhiHome)).not.toContain(KEY);
    // It no longer waits, and a second dismissal is refused.
    const again = await w.h.cmd("room.approve", { task: w.chat.id, item: card.id, decision: "reject" });
    expect(again.status).toBe(409);
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
    expect(card).toMatchObject({ state: "pending" });
    // Approving runs it with the real key.
    if (card?.type !== "approval") throw new Error("no card");
    const approved = await w.h.cmd("room.approve", { task: w.chat.id, item: card.id, decision: "approve" });
    expect(approved.body.item.state).toBe("applied");
    expect(await w.h.majhi.services.secrets.get("codex-acme")).toBe("sk-live-abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(await w.items())).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(await everythingOnDisk(w.h.env.majhiHome)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

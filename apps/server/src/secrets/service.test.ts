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
});

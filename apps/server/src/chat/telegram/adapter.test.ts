import type { ChatCursor, ChatEnvelope } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { ChatConnection, ChatSink } from "../adapter.ts";
import { FakeTelegram } from "../testing/fake-telegram.ts";
import { TelegramAdapter } from "./adapter.ts";

/** Test 2: the read position moves only after the batch is stored, and a restart neither repeats nor loses. */

const CONN: ChatConnection = {
  id: "telegram-acme",
  org: "acme",
  app: "telegram",
  account: "@majhi_test_bot",
  token: FakeTelegram.TOKEN,
  filesDir: "/tmp/majhi-chat-test",
};
const GROUP = { id: -100, type: "supergroup", title: "Kinbe ops" } as const;
const SARA = { id: 11, first_name: "Sara" };

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Gave up waiting for ${what}`);
}

function sink(stored: string[], options: { failOn?: string; failTimes?: number } = {}) {
  let failures = options.failTimes ?? 1;
  const saved: ChatCursor[] = [];
  const out: ChatSink = {
    deliver: async (e: ChatEnvelope) => {
      if (e.text === options.failOn && failures > 0) {
        failures -= 1;
        throw new Error("the database is busy");
      }
      stored.push(e.text);
    },
    save: (c) => saved.push(c),
    trouble: () => undefined,
    unreachable: () => undefined,
  };
  return { sink: out, saved };
}

describe("the Telegram read position", () => {
  it("moves only after the whole batch is stored, and a restart re-reads nothing stored and loses nothing", async () => {
    const api = new FakeTelegram();
    const adapter = new TelegramAdapter({ fetch: api.fetch, sleep: async () => undefined });
    api.push({ chat: GROUP, from: SARA, text: "first" });
    api.push({ chat: GROUP, from: SARA, text: "second" });

    // The second message cannot be stored the first time: nothing may be confirmed to Telegram.
    const stored: string[] = [];
    const run = sink(stored, { failOn: "second" });
    const stop = adapter.start(CONN, run.sink, undefined);
    await until(() => run.saved.length === 1, "the batch to be saved");
    stop();
    expect(run.saved[0]?.position.offset).toBe("3");
    // It asked again from the start, since nothing was confirmed after the failure.
    const offsets = api.offsets();
    expect(offsets[0]).toBeUndefined();
    expect(offsets[1]).toBeUndefined();
    expect(offsets.at(-1)).toBe(3);
    // The first message was handed over twice (the batch was read again), the second once it could be stored.
    expect(stored).toEqual(["first", "first", "second"]);
    expect(api.pending()).toEqual([]);

    // Majhi is off. A message comes in meanwhile.
    api.push({ chat: GROUP, from: SARA, text: "third" });
    const again: string[] = [];
    const next = sink(again);
    const stop2 = adapter.start(CONN, next.sink, run.saved[0]);
    await until(() => next.saved.length === 1, "the restart to save");
    stop2();
    expect(again).toEqual(["third"]);
    expect(api.offsets().find((o) => o === 3)).toBe(3);
    expect(next.saved[0]?.position.offset).toBe("4");
  });
});

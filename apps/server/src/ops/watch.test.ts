import type { ChatEnvelope } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { answers, down, MIN, type OpsWorld, opsWorld, SERVICE, up } from "./testing.ts";

const URL = SERVICE.url;

/** The owner pairs Telegram: sends `/start <code>` in a private chat, as the setup screen says. */
async function pairTelegram(w: OpsWorld): Promise<void> {
  const status = await w.ops.telegram.setup("tg-bot");
  const code = status.step
    ?.split(" ")
    .filter((p) => p !== "")
    .at(2);
  const envelope = {
    kind: "new",
    external: { app: "telegram", account: "@acme_bot", chat: "42", message: "1" },
    chat: { title: "Owner", kind: "private" },
    sender: { id: "42", name: "Owner", bot: false, verified: true },
    text: `/start ${code}`,
    files: [],
    at: w.clock.at.toISOString(),
  } satisfies ChatEnvelope;
  expect(await w.ops.telegram.claims("tg-bot", envelope)).toBe(true);
}

/** One look every `every` ms, `times` times. */
async function looks(w: OpsWorld, id: string, times: number, every: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const service = w.ops.repo.service(id);
    if (service === undefined) throw new Error("no service");
    await w.ops.watch.check(service, true);
    w.advance(every);
  }
}

describe("one incident, one ping", () => {
  it("merges 47 failing looks into one incident and one ping on every channel, and a flap does not ping again", async () => {
    const w = opsWorld();
    await w.ops.phone.setup({});
    await pairTelegram(w);
    const saved = await w.ops.watch.saveService(SERVICE);
    answers(w, URL, down());

    // 47 looks in 12 minutes.
    await looks(w, saved.id, 47, (12 * MIN) / 47);
    const open = (await w.ops.watch.overview()).incidents.filter((i) => i.status === "open");
    expect(open).toHaveLength(1);
    expect(w.ntfy).toHaveLength(1);
    expect(w.telegram.filter((t) => t.text.startsWith("Acme:"))).toEqual([
      { account: "@acme_bot", chat: "42", text: "Acme: incident, high. Open majhi." },
    ]);
    expect(w.alerts).toHaveLength(1);

    // It recovers and stays green for the close time.
    answers(w, URL, up());
    await looks(w, saved.id, 12, MIN);
    expect((await w.ops.watch.overview()).incidents.filter((i) => i.status === "open")).toHaveLength(0);

    // It fails again ten minutes later: the same incident, and nobody is pinged again.
    answers(w, URL, down());
    await looks(w, saved.id, 6, MIN / 2);
    const again = (await w.ops.watch.overview()).incidents;
    expect(again.filter((i) => i.status === "open")).toHaveLength(1);
    expect(again).toHaveLength(1);
    expect(again[0]?.flaps).toBe(1);
    expect(w.ntfy).toHaveLength(1);
    expect(w.telegram.filter((t) => t.text.startsWith("Acme:"))).toHaveLength(1);

    // After it closed and 45 minutes passed, failing again is a new incident and pings again.
    answers(w, URL, up());
    await looks(w, saved.id, 12, MIN);
    w.advance(45 * MIN);
    answers(w, URL, down());
    await looks(w, saved.id, 4, MIN / 2);
    expect((await w.ops.watch.overview()).incidents).toHaveLength(2);
    expect(w.ntfy).toHaveLength(2);
    expect(w.telegram.filter((t) => t.text.startsWith("Acme:"))).toHaveLength(2);
  });
});

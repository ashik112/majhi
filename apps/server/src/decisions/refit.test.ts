import { describe, expect, it } from "vitest";
import { MIN_LABELS, type SlotDef } from "./slots.ts";
import { service } from "./testkit.ts";

const slot: SlotDef = {
  id: "size-test",
  title: "Size",
  use: "task-size",
  question: /^difficulty$/,
  target: 0.9,
};

const ask = (n: number) => ({
  state: { task: `Fix typo number ${n}`, kind: "code" },
  questions: {
    difficulty: { type: "choice" as const, instructions: "How big?", options: ["trivial", "large"] },
  },
});

async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 20));
}

describe("fitting after new labels", () => {
  it("promotes a slot by itself once its labels meet the target, and not before", async () => {
    const { svc } = service(undefined, undefined, [slot]);
    for (let n = 0; n < MIN_LABELS - 1; n += 1) {
      const r = await svc.decide(ask(n), { use: "task-size" });
      svc.label({ id: r.id, right: "trivial" });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(svc.slots().find((s) => s.slot === slot.id)).toMatchObject({
      mode: "shadow",
      labels: MIN_LABELS - 1,
    });
    const last = await svc.decide(ask(MIN_LABELS), { use: "task-size" });
    svc.label({ id: last.id, right: "trivial" });
    await settled(() => svc.slots().find((s) => s.slot === slot.id)?.mode === "live");
    expect(svc.slots().find((s) => s.slot === slot.id)?.mode).toBe("live");
  });
});

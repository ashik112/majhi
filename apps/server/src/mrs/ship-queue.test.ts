import { describe, expect, it } from "vitest";
import { ShipQueue } from "./ship-queue.ts";

function gate() {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

describe("ShipQueue", () => {
  it("runs ships into one project and branch one at a time, in the order asked", async () => {
    const q = new ShipQueue();
    const key = ShipQueue.key("acme-api", "main");
    const log: string[] = [];
    const first = gate();
    const a = q.run([key], async () => {
      log.push("a start");
      await first.wait;
      log.push("a end");
    });
    const b = q.run([key], async () => {
      log.push("b start");
    });
    const c = q.run([key], async () => {
      log.push("c start");
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(["a start"]);
    first.open();
    await Promise.all([a, b, c]);
    expect(log).toEqual(["a start", "a end", "b start", "c start"]);
  });

  it("does not hold back ships into another branch or project", async () => {
    const q = new ShipQueue();
    const first = gate();
    const log: string[] = [];
    const a = q.run([ShipQueue.key("acme-api", "main")], async () => {
      await first.wait;
    });
    await q.run([ShipQueue.key("acme-api", "release")], async () => {
      log.push("release");
    });
    await q.run([ShipQueue.key("acme-web", "main")], async () => {
      log.push("web");
    });
    expect(log).toEqual(["release", "web"]);
    first.open();
    await a;
  });

  it("a failed ship lets the next one go", async () => {
    const q = new ShipQueue();
    const key = ShipQueue.key("acme-api", "main");
    const a = q.run([key], async () => {
      throw new Error("conflict");
    });
    const b = q.run([key], async () => "ok");
    await expect(a).rejects.toThrow("conflict");
    expect(await b).toBe("ok");
    expect(q.busy(key)).toBe(false);
  });
});

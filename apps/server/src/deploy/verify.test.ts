import { describe, expect, it } from "vitest";
import { type VerifyDeps, verifyDeploy } from "./verify.ts";

/** A clock that only moves when the check sleeps, and the answers of the health address in order. */
function world(answers: (number | undefined)[], watch: boolean[] = []) {
  let at = 0;
  const looks: { health: number; watch: number } = { health: 0, watch: 0 };
  const deps: VerifyDeps = {
    health: async () => {
      const a = answers[Math.min(looks.health++, answers.length - 1)];
      return a === undefined ? undefined : { status: a };
    },
    watch: async () => {
      const ok = watch[Math.min(looks.watch++, watch.length - 1)] ?? true;
      return { ok, detail: ok ? "ok" : "alerting" };
    },
    sleep: async (ms) => {
      at += ms;
    },
    now: () => at,
    everyMs: 5_000,
  };
  return { deps, looks };
}

describe("verifyDeploy", () => {
  it("is green when the address answers 2xx until the end of the wait", async () => {
    const { deps, looks } = world([200]);
    expect(await verifyDeploy({ health: "https://a.example/h", waitSeconds: 20 }, deps)).toEqual({
      ok: true,
      detail: "Healthy for 20 s",
    });
    expect(looks.health).toBe(5);
  });

  it("forgives the new version still starting, then holds it to being up", async () => {
    const { deps } = world([502, undefined, 200, 200]);
    expect((await verifyDeploy({ health: "https://a.example/h", waitSeconds: 15 }, deps)).ok).toBe(true);
  });

  it("fails at once when it was up and then is not", async () => {
    const { deps, looks } = world([200, 200, 500, 200]);
    const result = await verifyDeploy({ health: "https://a.example/h", waitSeconds: 60 }, deps);
    expect(result).toEqual({ ok: false, detail: "It was up, then the health address answered 500" });
    expect(looks.health).toBe(3);
  });

  it("fails with the last thing seen when it never comes up", async () => {
    const { deps } = world([503]);
    expect(await verifyDeploy({ health: "https://a.example/h", waitSeconds: 10 }, deps)).toEqual({
      ok: false,
      detail: "Not healthy after 10 s: the health address answered 503",
    });
  });

  it("needs the watch green as well as the address", async () => {
    const { deps } = world([200], [true, false]);
    const result = await verifyDeploy(
      { health: "https://a.example/h", watch: "wch-abcd", waitSeconds: 30 },
      deps,
    );
    expect(result).toEqual({ ok: false, detail: "It was up, then the watch says alerting" });
  });

  it("looks once when the wait is zero", async () => {
    const { deps, looks } = world([200]);
    expect((await verifyDeploy({ health: "https://a.example/h", waitSeconds: 0 }, deps)).ok).toBe(true);
    expect(looks.health).toBe(1);
  });
});

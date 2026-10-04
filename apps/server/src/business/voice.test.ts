import { VoiceProposeInputSchema, VoiceSetInputSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import type { BusinessActor } from "./scope.ts";
import { VoiceService } from "./voice.ts";

/** Voice profiles: the owner sets, the captain proposes, a workspace falls back to the business voice. */

const OWNER: BusinessActor = { kind: "owner" };
const ACME: BusinessActor = { kind: "captain", org: "acme" };
const BOSS: BusinessActor = { kind: "captain" };
const GLOBEX: BusinessActor = { kind: "agent", id: "writer", org: "globex" };

function setup() {
  const store = new Store(":memory:");
  const orgs = new Set(["acme", "globex", "private"]);
  const voice = new VoiceService({
    db: store.raw,
    now: () => new Date("2026-10-04T08:00:00.000Z"),
    orgExists: async (o) => orgs.has(o),
  });
  const set = (over: Record<string, unknown>) =>
    voice.set(VoiceSetInputSchema.parse({ tone: "Plain.", ...over }), OWNER);
  const propose = (over: Record<string, unknown>, actor: BusinessActor) =>
    voice.propose(
      VoiceProposeInputSchema.parse({ tone: "Dry.", why: "From the three posts you sent.", ...over }),
      actor,
    );
  return { voice, set, propose };
}

describe("voice", () => {
  it("uses the workspace voice when it has one and the business voice otherwise", async () => {
    const t = setup();
    expect(t.voice.get(undefined, OWNER)).toEqual({ inherited: false });
    await t.set({ tone: "Business voice." });
    expect(t.voice.get("acme", ACME)).toMatchObject({
      inherited: true,
      effective: { tone: "Business voice." },
    });
    await t.set({ org: "acme", tone: "Acme voice.", signOffs: ["Cheers"] });
    const acme = t.voice.get(undefined, ACME);
    expect(acme).toMatchObject({
      inherited: false,
      effective: { tone: "Acme voice.", signOffs: ["Cheers"] },
    });
    expect(t.voice.get(undefined, GLOBEX)).toMatchObject({
      inherited: true,
      effective: { tone: "Business voice." },
    });
  });

  it("keeps a proposal apart until the owner accepts it, and never lets an agent set the voice", async () => {
    const t = setup();
    await t.set({ org: "acme", tone: "Acme voice.", samples: ["Hello, thanks for writing."] });
    const proposed = await t.propose({ org: "acme", tone: "Short and dry.", use: ["ship"] }, ACME);
    expect(proposed.own?.tone).toBe("Acme voice.");
    expect(proposed.proposal).toMatchObject({ tone: "Short and dry.", by: "captain" });
    await expect(t.voice.set(VoiceSetInputSchema.parse({ tone: "Mine." }), ACME)).rejects.toThrow(
      /Only the owner/,
    );
    await expect(t.voice.decide({ org: "acme", accept: true }, ACME)).rejects.toThrow(/Only the owner/);
    const accepted = await t.voice.decide({ org: "acme", accept: true }, OWNER);
    expect(accepted.own).toMatchObject({ tone: "Short and dry.", use: ["ship"], by: "owner" });
    // The owner's pasted samples are not replaced by a proposal's.
    expect(accepted.own?.samples).toEqual(["Hello, thanks for writing."]);
    expect(accepted.proposal).toBeUndefined();
    await expect(t.voice.decide({ org: "acme", accept: true }, OWNER)).rejects.toThrow(
      /No voice is proposed/,
    );
  });

  it("drops a proposal the owner declines", async () => {
    const t = setup();
    await t.set({ org: "acme", tone: "Acme voice." });
    await t.propose({ org: "acme", tone: "Other." }, ACME);
    const dropped = await t.voice.decide({ org: "acme", accept: false }, OWNER);
    expect(dropped.own?.tone).toBe("Acme voice.");
    expect(dropped.proposal).toBeUndefined();
  });

  it("keeps a workspace's voice and proposals out of another workspace's reach", async () => {
    const t = setup();
    await t.set({ org: "globex", tone: "Globex voice.", samples: ["Private sample of Globex."] });
    expect(() => t.voice.get("globex", ACME)).toThrow(/another workspace/);
    expect(t.voice.get(undefined, ACME).effective).toBeUndefined();
    await expect(t.propose({ org: "globex" }, ACME)).rejects.toThrow(/another workspace/);
    // A tied actor cannot propose the business-wide voice; the unscoped captain can.
    await expect(t.propose({}, GLOBEX)).resolves.toMatchObject({ proposal: { org: "globex" } });
    await expect(t.propose({}, BOSS)).resolves.toMatchObject({ proposal: { by: "captain" } });
    await expect(t.propose({ org: "nowhere" }, BOSS)).rejects.toThrow(/does not exist/);
  });

  it("refuses an oversized profile", () => {
    expect(VoiceSetInputSchema.safeParse({ samples: ["x".repeat(4_001)] }).success).toBe(false);
    expect(VoiceSetInputSchema.safeParse({ examples: Array.from({ length: 9 }, () => "x") }).success).toBe(
      false,
    );
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";

const BOSS = { actor: { kind: "agent", id: "majhi-boss" } };

describe("connections commands", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
    expect((await h.cmd("orgs.create", { id: "acme", name: "Acme" })).status).toBe(200);
  });
  afterEach(() => h.cleanup());

  it("keeps an agent from loosening the gate, even without a secret", async () => {
    await h.cmd("connections.create", {
      org: "acme",
      id: "acme-tools",
      type: "env",
      name: "Tools",
      fields: { clis: "aws" },
    });
    const clis = await h.cmd("connections.update", { id: "acme-tools", fields: { clis: null } }, BOSS);
    expect(clis.status).toBe(409);
    await h.cmd("connections.create", { org: "acme", id: "acme-nr", type: "mcp", name: "NR" });
    const reads = await h.cmd(
      "connections.update",
      { id: "acme-nr", fields: { read_tools: "delete_everything" } },
      BOSS,
    );
    expect(reads.status).toBe(409);
    const owner = await h.cmd("connections.update", { id: "acme-nr", fields: { read_tools: "run_nrql" } });
    expect(owner.body.fields.read_tools).toEqual({ kind: "text", set: true, value: "run_nrql" });
  });
});

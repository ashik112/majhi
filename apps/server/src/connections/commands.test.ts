import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";

const PASSWORD = "app-password-0123456789";
const BOSS = { actor: { kind: "agent", id: "majhi-boss" } };

describe("connections commands", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
    expect((await h.cmd("orgs.create", { id: "acme", name: "Acme" })).status).toBe(200);
  });
  afterEach(() => h.cleanup());

  async function mail() {
    const created = await h.cmd("connections.create", {
      org: "acme",
      type: "mail",
      name: "Ops mailbox",
      description: "The ops inbox. Read alerts here.",
      fields: { imap_host: "imap.acme.com", user: "ops@acme.com" },
    });
    expect(created.status).toBe(200);
    expect(created.body.problems).toEqual(["Password is not set"]);
    const set = await h.cmd("connections.setSecret", {
      id: "ops-mailbox",
      field: "password",
      value: PASSWORD,
    });
    expect(set.status).toBe(200);
    return set.body;
  }

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

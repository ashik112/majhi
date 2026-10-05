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

  it("never returns a secret's value, only whether it is set", async () => {
    const view = await mail();
    expect(view.fields.password).toEqual({ kind: "secret", set: true });
    expect(view.problems).toEqual([]);
    const got = await h.cmd("connections.get", { id: "ops-mailbox" });
    const listed = await h.cmd("connections.list", { org: "acme" });
    for (const body of [view, got.body, listed.body]) expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect(await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8")).not.toContain(PASSWORD);
    // The config history names the field, never the value.
    expect((await h.log("%B")).join("\n")).not.toContain(PASSWORD);
  });

  it("takes only a reference from an agent", async () => {
    await mail();
    const raw = await h.cmd(
      "connections.setSecret",
      { id: "ops-mailbox", field: "password", value: "agent-typed-0123456789" },
      BOSS,
    );
    expect(raw.status).toBe(409);
    const saved = await h.cmd("secrets.save", { name: "acme-mail", value: "from-a-secret-request-0123" });
    const ref = await h.cmd(
      "connections.setSecret",
      { id: "ops-mailbox", field: "password", ref: saved.body.ref },
      BOSS,
    );
    expect(ref.status).toBe(200);
    expect(ref.body.fields.password).toEqual({ kind: "secret", set: true });
  });

  it("keeps an agent from sending a secret somewhere else", async () => {
    const gh = await h.cmd("secrets.save", { name: "acme-gh", value: "gh-token-0123456789abcdef" });
    await h.cmd("orgs.update", { id: "acme", mr_tokens: { github: gh.body.ref } });
    await mail();
    const reuse = await h.cmd(
      "connections.setSecret",
      { id: "ops-mailbox", field: "password", ref: gh.body.ref },
      BOSS,
    );
    expect(reuse.status).toBe(409);
    const move = await h.cmd(
      "connections.update",
      { id: "ops-mailbox", fields: { imap_host: "imap.globex.example" } },
      BOSS,
    );
    expect(move.status).toBe(409);
    const variable = await h.cmd(
      "connections.update",
      { id: "ops-mailbox", env: { HOST: { kind: "text", value: "x" } } },
      BOSS,
    );
    expect(variable.status).toBe(409);
    expect((await h.cmd("connections.update", { id: "ops-mailbox", name: "Inbox" }, BOSS)).status).toBe(200);
    const owner = await h.cmd("connections.update", {
      id: "ops-mailbox",
      fields: { imap_host: "mail.acme.com" },
    });
    expect(owner.body.fields.imap_host).toEqual({ kind: "text", set: true, value: "mail.acme.com" });
  });

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

  it("lets only the owner switch a connection off or on for an agent", async () => {
    await h.cmd("connections.create", { org: "acme", id: "acme-nr", type: "mcp", name: "NR" });
    const agent = await h.cmd("connections.update", { id: "acme-nr", agentsOff: [] }, BOSS);
    expect(agent.status).toBe(409);
    const off = await h.cmd("connections.update", { id: "acme-nr", agentsOff: ["acme-dev"] });
    expect(off.body.agentsOff).toEqual(["acme-dev"]);
    const on = await h.cmd("connections.update", { id: "acme-nr", agentsOff: [] });
    expect(on.body.agentsOff).toEqual([]);
  });
});

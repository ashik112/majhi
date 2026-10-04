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
    expect(await h.log()).toContain("connections.setSecret: set password of connection ops-mailbox");
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
    expect(clis.body.error).toContain("Only the owner changes the clis");
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
    expect(agent.body.error).toContain("Only the owner changes the agents");
    const off = await h.cmd("connections.update", { id: "acme-nr", agentsOff: ["acme-dev"] });
    expect(off.body.agentsOff).toEqual(["acme-dev"]);
    const on = await h.cmd("connections.update", { id: "acme-nr", agentsOff: [] });
    expect(on.body.agentsOff).toEqual([]);
  });

  it("tests a connection, and Health shows the last Test without testing on its own", async () => {
    await h.cmd("connections.create", { org: "acme", id: "acme-box", type: "ssh", name: "Box" });
    expect((await h.cmd("connections.test", { id: "acme-box" })).body).toMatchObject({
      ok: false,
      detail: "Host is not set.",
      warnings: [],
    });
    await h.cmd("connections.update", { id: "acme-box", fields: { alias: "nowhere" } });
    await h.cmd("connections.create", {
      org: "acme",
      id: "acme-lab",
      type: "ssh",
      name: "Lab",
      fields: { alias: "lab" },
    });
    expect((await h.cmd("connections.test", { id: "acme-box" })).body.detail).toBe(
      "~/.ssh/config has no Host nowhere.",
    );
    const rows = (await h.cmd("health.run", {})).body.checks;
    const row = (id: string) => rows.find((c: { id: string }) => c.id === `connection:${id}`);
    expect(row("acme-box")).toMatchObject({
      group: "connections",
      level: "fail",
      fix: { label: "Test again" },
    });
    expect(row("acme-lab")).toMatchObject({ level: "warn", detail: "Not tested since majhi started." });
    expect((await h.cmd("connections.get", { id: "acme-lab" })).body.lastTest).toBeUndefined();
    const fixed = await h.cmd("health.fix", { id: "connection:acme-lab" });
    expect(fixed.body).toEqual({ ok: false, detail: "~/.ssh/config has no Host lab." });
  });

  it("sets a file from a connection upload of any type", async () => {
    await h.cmd("connections.create", {
      org: "acme",
      id: "acme-prod",
      type: "kubectl",
      name: "Acme prod",
      fields: { context: "prod" },
    });
    const form = new FormData();
    form.append("file", new File(["apiVersion: v1\nkind: Config\n"], "config"), "config");
    const plain = await h.majhi.app.request("/api/uploads", { method: "POST", body: form });
    expect(plain.status).toBe(400);
    const res = await h.majhi.app.request("/api/uploads?for=connection", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const upload = (await res.json()) as { id: string };
    const set = await h.cmd("connections.setFile", {
      id: "acme-prod",
      field: "kubeconfig",
      upload: upload.id,
    });
    expect(set.status).toBe(200);
    expect(set.body.fields.kubeconfig).toEqual({ kind: "file", set: true });
    const types = await h.cmd("connections.types", {});
    expect(types.body.map((t: { type: string }) => t.type)).toEqual([
      "kubectl",
      "mcp",
      "ssh",
      "env",
      "mail",
      "browser",
      "api",
      "cli",
      "git",
    ]);
  });

  it("lets a task name connections for its root agents, and only ones that exist", async () => {
    await mail();
    const created = await h.cmd("tasks.create", {
      text: "Why are the ops alerts late",
      kind: "ops",
      start: false,
      connections: ["ops-mailbox"],
    });
    expect(created.status).toBe(200);
    expect(created.body.connections).toEqual(["ops-mailbox"]);
    expect((await h.cmd("tasks.get", { id: created.body.id })).body.connections).toEqual(["ops-mailbox"]);
    const unknown = await h.cmd("tasks.create", { text: "Look", start: false, connections: ["nowhere"] });
    expect(unknown.status).toBe(404);
  });

  it("removes a connection with its secret", async () => {
    await mail();
    const removed = await h.cmd("connections.remove", { id: "ops-mailbox" });
    expect(removed.body).toEqual({ removed: "ops-mailbox" });
    expect((await h.cmd("connections.list", {})).body).toEqual([]);
    expect((await h.cmd("secrets.list", {})).body).toEqual([]);
  });
});

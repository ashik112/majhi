import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(w.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  // The SDK types its optional session id without `undefined`, which our strict settings reject.
  await client.connect(transport as unknown as Transport);
  return client;
}

const token = () => w.h.majhi.services.adminTokens.issue({ task: w.chat.id, agent: "boss" });

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const first = (res.content as { type: string; text: string }[])[0];
  return { text: first?.text ?? "", isError: res.isError === true };
}

describe("majhi-admin MCP server", () => {
  it("answers 401 without a valid token and 403 to a foreign origin", async () => {
    w = await bossWorld({ real: false });
    const post = (headers: Record<string, string>) =>
      fetch(w.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer nope" })).status).toBe(401);
    expect((await post({ authorization: "Basic abc" })).status).toBe(401);
    const good = w.h.majhi.services.adminTokens.issue({ task: w.chat.id, agent: "boss" });
    expect((await post({ authorization: `Bearer ${good}`, origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await post({ authorization: `Bearer ${good}` })).status).toBe(200);
    w.h.majhi.services.adminTokens.revoke(good);
    expect((await post({ authorization: `Bearer ${good}` })).status).toBe(401);
  });

  it("lists one tool per command with the extra fields, and leaves out the ones an agent must not call", async () => {
    w = await bossWorld({ real: false });
    const client = await connect(token());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("majhi_orgs_create");
    expect(names).toContain("majhi_accounts_login_start");
    expect(names).toContain("majhi_history_undo");
    expect(names).toContain("majhi_request_secret");
    for (const banned of [
      "majhi_room_approve",
      "majhi_room_secret",
      "majhi_policy_set",
      "majhi_room_permission",
      "majhi_ssh_unlock",
    ]) {
      expect(names).not.toContain(banned);
    }
    const create = tools.find((t) => t.name === "majhi_orgs_create");
    expect(create?.description).toBe("Create an org. Risk: change.");
    expect(create?.inputSchema.required).toEqual(
      expect.arrayContaining(["id", "name", "ownerAsked", "reason"]),
    );
    expect(create?.inputSchema.properties).toHaveProperty("ownerAsked");
    await client.close();
  });

  it("runs a read tool without a card", async () => {
    w = await bossWorld({ real: false });
    const client = await connect(token());
    const res = await call(client, "majhi_orgs_list", { ownerAsked: false, reason: "look" });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toMatchObject([{ id: "acme" }]);
    expect((await w.items()).filter((i) => i.type === "approval")).toEqual([]);
    await client.close();
  });

  it("runs a change when the owner asked, records who did it, and can undo it", async () => {
    w = await bossWorld({ real: false });
    const client = await connect(token());
    const res = await call(client, "majhi_orgs_create", {
      id: "globex",
      name: "Globex",
      ownerAsked: true,
      reason: "You asked for Globex",
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toMatchObject({ id: "globex" });
    const card = (await w.items()).find((i) => i.type === "approval");
    expect(card).toMatchObject({
      state: "applied",
      command: "orgs.create",
      risk: "change",
      summary: "Create org Globex",
      reason: "You asked for Globex",
      agent: "boss",
    });
    const history = await w.h.cmd("history.list", { limit: 5 });
    expect(history.body[0]).toMatchObject({
      actor: "boss",
      command: "orgs.create",
      reason: "You asked for Globex",
      undone: false,
    });
    if (card?.type !== "approval") throw new Error("no card");
    expect(card.commit).toBe(history.body[0].commit);
    await client.close();
  });

  it("makes a change wait when the owner did not ask, and a destructive one always", async () => {
    w = await bossWorld({ real: false });
    const client = await connect(token());
    const waiting = await call(client, "majhi_orgs_create", {
      id: "globex",
      name: "Globex",
      ownerAsked: false,
      reason: "seems useful",
    });
    expect(waiting.text).toBe(
      "Waiting for the owner to approve in the room. You will get a message with the decision.",
    );
    expect(waiting.isError).toBe(false);
    expect((await w.h.cmd("orgs.list")).body.map((o: { id: string }) => o.id)).toEqual(["acme"]);

    const destructive = await call(client, "majhi_agents_remove", {
      id: "acme-builder",
      ownerAsked: true,
      reason: "you asked",
    });
    expect(destructive.text).toContain("Waiting for the owner");
    const cards = (await w.items()).filter((i) => i.type === "approval");
    expect(cards.map((c) => c.type === "approval" && [c.command, c.state])).toEqual([
      ["orgs.create", "pending"],
      ["agents.remove", "pending"],
    ]);
    expect(
      (await w.h.cmd("agents.list")).body.map(
        (a: { agent: { frontmatter: { id: string } } }) => a.agent.frontmatter.id,
      ),
    ).toContain("acme-builder");
    await client.close();
  });

  it("returns invalid input as an error the agent can read, without a card", async () => {
    w = await bossWorld({ real: false });
    const client = await connect(token());
    const res = await call(client, "majhi_orgs_create", {
      id: "Bad Id",
      name: "x",
      ownerAsked: true,
      reason: "r",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Invalid input for orgs.create");
    expect((await w.items()).filter((i) => i.type === "approval")).toEqual([]);
    await client.close();
  });

  it("posts a secret request card and never returns a value", async () => {
    w = await bossWorld({ real: false });
    const client = await connect(token());
    const res = await call(client, "majhi_request_secret", {
      name: "newrelic-acme",
      label: "New Relic key for Acme",
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("secret:newrelic-acme");
    expect((await w.items()).find((i) => i.type === "secret-request")).toMatchObject({
      name: "newrelic-acme",
      label: "New Relic key for Acme",
      state: "pending",
    });
    expect((await call(client, "majhi_request_secret", { name: "Bad Name", label: "x" })).isError).toBe(true);
    await client.close();
  });

  it("answers an unknown tool with an error", async () => {
    w = await bossWorld({ real: false });
    const client = await connect(token());
    expect((await call(client, "majhi_nothing", {})).isError).toBe(true);
    await client.close();
  });
});

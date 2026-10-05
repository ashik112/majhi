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

  it("makes a change wait when the owner did not ask, and a destructive one always", async () => {
    w = await bossWorld({ real: false });
    const client = await connect(token());
    const waiting = await call(client, "majhi_orgs_create", {
      id: "globex",
      name: "Globex",
      ownerAsked: false,
      reason: "seems useful",
    });
    expect(waiting.isError).toBe(false);
    expect((await w.h.cmd("orgs.list")).body.map((o: { id: string }) => o.id)).toEqual(["private", "acme"]);

    const destructive = await call(client, "majhi_agents_remove", {
      id: "acme-builder",
      ownerAsked: true,
      reason: "you asked",
    });
    expect(destructive.isError).toBe(false);
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
});

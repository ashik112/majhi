import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

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
});

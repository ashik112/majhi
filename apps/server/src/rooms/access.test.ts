import { describe, expect, it } from "vitest";
import { ROOM_SERVER_NAME, RoomAccess } from "./access.ts";

const access = () =>
  new RoomAccess(
    () => "http://majhi-server:7070/mcp",
    () => true,
  );

describe("session tokens of the majhi MCP servers", () => {
  it("belong to one task and agent: another task's token never resolves to this one", () => {
    const a = access();
    const acme = a.attach({ task: "ACM-1", agent: "dev" }, [ROOM_SERVER_NAME]);
    const globex = a.attach({ task: "GLX-1", agent: "dev" }, [ROOM_SERVER_NAME]);
    const acmeToken = acme.tokens[0]?.token ?? "";
    const globexToken = globex.tokens[0]?.token ?? "";
    expect(acmeToken).not.toBe(globexToken);
    expect(a.room.lookup(acmeToken)).toEqual({ task: "ACM-1", agent: "dev" });
    expect(a.room.lookup(globexToken)).toEqual({ task: "GLX-1", agent: "dev" });
    // A token stops working the moment its session ends.
    a.revoke(acme.tokens);
    expect(a.room.lookup(acmeToken)).toBeUndefined();
    expect(a.room.size).toBe(1);
  });
});

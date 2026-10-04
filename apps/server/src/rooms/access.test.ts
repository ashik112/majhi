import { describe, expect, it } from "vitest";
import { ROOM_SERVER_NAME, RoomAccess, TASKS_SERVER_NAME } from "./access.ts";

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
  });

  it("work on the server they were issued for and no other", () => {
    const a = access();
    const issued = a.attach({ task: "ACM-1", agent: "dev" }, [ROOM_SERVER_NAME, TASKS_SERVER_NAME]);
    const room = issued.tokens.find((t) => t.server === "room")?.token ?? "";
    expect(a.room.lookup(room)).toBeDefined();
    expect(a.tasks.lookup(room)).toBeUndefined();
    expect(a.processes.lookup(room)).toBeUndefined();
    expect(a.docker.lookup(room)).toBeUndefined();
    expect(a.connections.lookup(room)).toBeUndefined();
  });

  it("stop working the moment the session ends", () => {
    const a = access();
    const issued = a.attach({ task: "ACM-1", agent: "dev" }, [ROOM_SERVER_NAME]);
    const token = issued.tokens[0]?.token ?? "";
    a.revoke(issued.tokens);
    expect(a.room.lookup(token)).toBeUndefined();
    expect(a.room.size).toBe(0);
  });

  it("hand out only the servers asked for, and a docker token that reaches only its own task", () => {
    const a = access();
    expect(a.attach({ task: "ACM-1", agent: "dev" }, ["not-ours"]).servers).toEqual([]);
    const docker = a.attachDocker({ task: "ACM-1", agent: "dev" });
    expect(a.docker.lookup(docker?.entry.token ?? "")).toEqual({ task: "ACM-1", agent: "dev" });
    expect(a.docker.lookup("guess")).toBeUndefined();
  });
});

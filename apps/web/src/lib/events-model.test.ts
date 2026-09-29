import { describe, expect, it } from "vitest";
import { parseServerEvent, reconnectDelay, topicQueryKeys, wsUrl } from "./events-model";

describe("topicQueryKeys", () => {
  it("maps each topic to the queries it changes", () => {
    expect(topicQueryKeys("agents")).toEqual([["agents"]]);
    expect(topicQueryKeys("orgs")).toEqual([["orgs"]]);
    expect(topicQueryKeys("config")).toEqual([["config"]]);
    expect(topicQueryKeys("projects")).toEqual([["projects"]]);
    expect(topicQueryKeys("tasks")).toEqual([["tasks"]]);
    expect(topicQueryKeys("accounts")).toEqual([["accounts"], ["account-models"]]);
  });
});

describe("parseServerEvent", () => {
  it("accepts a changed event", () => {
    expect(parseServerEvent('{"type":"changed","topics":["agents","orgs"]}')).toEqual({
      type: "changed",
      topics: ["agents", "orgs"],
    });
  });
  it("drops garbage, unknown topics and binary frames", () => {
    expect(parseServerEvent("nope")).toBeNull();
    expect(parseServerEvent('{"type":"changed","topics":["weather"]}')).toBeNull();
    expect(parseServerEvent('{"type":"changed","topics":[]}')).toBeNull();
    expect(parseServerEvent(new ArrayBuffer(2))).toBeNull();
  });
});

describe("reconnectDelay", () => {
  it("doubles and stops at 10 s", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
  });
});

describe("wsUrl", () => {
  it("follows the page protocol", () => {
    expect(wsUrl("/api/events", { protocol: "http:", host: "localhost:7070" })).toBe(
      "ws://localhost:7070/api/events",
    );
    expect(wsUrl("/api/term/a", { protocol: "https:", host: "x.dev" })).toBe("wss://x.dev/api/term/a");
  });
});

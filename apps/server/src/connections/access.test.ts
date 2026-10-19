import type { ConnectionConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { runConnections } from "./access.ts";

const conn = (name: string): ConnectionConfig => ({ type: "ssh", name, fields: { alias: name } });
const orgs = {
  acme: { connections: { "acme-prod": conn("prod"), "acme-logs": conn("logs") } },
  globex: { connections: { "globex-prod": conn("prod") } },
  initech: {},
};
const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe("runConnections", () => {
  it("never gives an org agent another org's connection, even working in that org", () => {
    const agent = { id: "acme-dev", scope: "acme" };
    const globexTask = { org: "globex", connections: ["globex-prod", "acme-prod"] };
    expect(runConnections({ agent, task: globexTask, orgs })).toEqual([]);
    const attachedAcmeTask = { org: "acme", connections: ["globex-prod"] };
    expect(ids(runConnections({ agent, task: attachedAcmeTask, orgs }))).toEqual(["acme-prod", "acme-logs"]);
    const globexAgent = { id: "globex-dev", scope: "globex" };
    expect(runConnections({ agent: globexAgent, task: { org: "acme", connections: [] }, orgs })).toEqual([]);
  });
});

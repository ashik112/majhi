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
  it("gives an org agent the listed connections of its own org, in a task of its org", () => {
    const agent = { scope: "acme", connections: ["acme-prod", "globex-prod"] };
    expect(ids(runConnections({ agent, task: { org: "acme", connections: [] }, orgs }))).toEqual([
      "acme-prod",
    ]);
  });

  it("never gives an org agent another org's connection, even working in that org", () => {
    const agent = { scope: "acme", connections: ["acme-prod", "globex-prod"] };
    const globexTask = { org: "globex", connections: ["globex-prod", "acme-prod"] };
    expect(runConnections({ agent, task: globexTask, orgs })).toEqual([]);
    const attachedAcmeTask = { org: "acme", connections: ["globex-prod"] };
    expect(ids(runConnections({ agent, task: attachedAcmeTask, orgs }))).toEqual(["acme-prod"]);
    const globexAgent = { scope: "globex", connections: ["globex-prod"] };
    expect(runConnections({ agent: globexAgent, task: { org: "acme", connections: [] }, orgs })).toEqual([]);
  });

  it("gives an org agent nothing in a task without an org", () => {
    const agent = { scope: "acme", connections: ["acme-prod"] };
    expect(runConnections({ agent, task: { org: undefined, connections: ["acme-prod"] }, orgs })).toEqual([]);
  });

  it("gives a root agent every connection of the task's org, and the ones the task names", () => {
    const root = { scope: "root", connections: [] };
    expect(ids(runConnections({ agent: root, task: { org: "acme", connections: [] }, orgs }))).toEqual([
      "acme-prod",
      "acme-logs",
    ]);
    const attached = runConnections({
      agent: root,
      task: { org: "acme", connections: ["globex-prod", "acme-prod"] },
      orgs,
    });
    expect(attached.map((c) => [c.id, c.org])).toEqual([
      ["acme-prod", "acme"],
      ["acme-logs", "acme"],
      ["globex-prod", "globex"],
    ]);
  });

  it("gives a root agent in a task without an org only what the task names or had attached", () => {
    const root = { scope: "root", connections: ["acme-logs"] };
    expect(ids(runConnections({ agent: root, task: { org: undefined, connections: [] }, orgs }))).toEqual([]);
    const task = { org: undefined, connections: ["globex-prod", "gone"] };
    expect(ids(runConnections({ agent: root, task, orgs }))).toEqual(["globex-prod"]);
  });
  it("shares only explicit Global connections with every workspace, after workspace-specific connections", () => {
    const global = { "shared-cloud": conn("shared") };
    const task = { org: "acme", connections: [] };
    expect(
      ids(runConnections({ agent: { scope: "acme", connections: ["acme-prod"] }, task, orgs, global })),
    ).toEqual(["acme-prod", "shared-cloud"]);
    expect(
      ids(
        runConnections({
          agent: { scope: "globex", connections: [] },
          task: { org: "globex", connections: [] },
          orgs,
          global,
        }),
      ),
    ).toEqual(["shared-cloud"]);
    expect(
      runConnections({
        agent: { scope: "acme", connections: [] },
        task: { org: "globex", connections: [] },
        orgs,
        global,
      }),
    ).toEqual([]);
    const root = { scope: "root", connections: [] };
    expect(
      runConnections({ agent: root, task: { org: undefined, connections: ["shared-cloud"] }, orgs, global }),
    ).toEqual([{ id: "shared-cloud", org: "global", connection: global["shared-cloud"] }]);
  });
});

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
  it("keeps a connection from the agents its agents_off names, root agents too", () => {
    const off = {
      ...orgs,
      acme: {
        connections: {
          "acme-prod": { ...conn("prod"), agents_off: ["acme-dev", "lead"] },
          "acme-logs": conn("logs"),
        },
      },
    };
    const task = { org: "acme", connections: [] };
    expect(ids(runConnections({ agent: { id: "acme-dev", scope: "acme" }, task, orgs: off }))).toEqual([
      "acme-logs",
    ]);
    expect(ids(runConnections({ agent: { id: "acme-ops", scope: "acme" }, task, orgs: off }))).toEqual([
      "acme-prod",
      "acme-logs",
    ]);
    expect(ids(runConnections({ agent: { id: "lead", scope: "root" }, task, orgs: off }))).toEqual([
      "acme-logs",
    ]);
    expect(ids(runConnections({ agent: { scope: "root" }, task, orgs: off }))).toEqual([
      "acme-prod",
      "acme-logs",
    ]);
  });

  it("never gives an org agent another org's connection, even working in that org", () => {
    const agent = { id: "acme-dev", scope: "acme" };
    const globexTask = { org: "globex", connections: ["globex-prod", "acme-prod"] };
    expect(runConnections({ agent, task: globexTask, orgs })).toEqual([]);
    const attachedAcmeTask = { org: "acme", connections: ["globex-prod"] };
    expect(ids(runConnections({ agent, task: attachedAcmeTask, orgs }))).toEqual(["acme-prod", "acme-logs"]);
    const globexAgent = { id: "globex-dev", scope: "globex" };
    expect(runConnections({ agent: globexAgent, task: { org: "acme", connections: [] }, orgs })).toEqual([]);
  });

  it("gives an org agent nothing in a task without an org", () => {
    const agent = { id: "acme-dev", scope: "acme" };
    expect(runConnections({ agent, task: { org: undefined, connections: ["acme-prod"] }, orgs })).toEqual([]);
  });

  it("gives a root agent every connection of the task's org, and the ones the task names", () => {
    const root = { id: "lead", scope: "root" };
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
    const root = { id: "lead", scope: "root" };
    expect(ids(runConnections({ agent: root, task: { org: undefined, connections: [] }, orgs }))).toEqual([]);
    const task = { org: undefined, connections: ["globex-prod", "gone"] };
    expect(ids(runConnections({ agent: root, task, orgs }))).toEqual(["globex-prod"]);
  });
  it("shares only explicit Global connections with every workspace, after workspace-specific connections", () => {
    const global = { "shared-cloud": conn("shared") };
    const task = { org: "acme", connections: [] };
    expect(ids(runConnections({ agent: { id: "acme-dev", scope: "acme" }, task, orgs, global }))).toEqual([
      "acme-prod",
      "acme-logs",
      "shared-cloud",
    ]);
    expect(
      ids(
        runConnections({
          agent: { id: "globex-dev", scope: "globex" },
          task: { org: "globex", connections: [] },
          orgs,
          global,
        }),
      ),
    ).toEqual(["globex-prod", "shared-cloud"]);
    expect(
      runConnections({
        agent: { id: "acme-dev", scope: "acme" },
        task: { org: "globex", connections: [] },
        orgs,
        global,
      }),
    ).toEqual([]);
    const root = { id: "lead", scope: "root" };
    expect(
      runConnections({ agent: root, task: { org: undefined, connections: ["shared-cloud"] }, orgs, global }),
    ).toEqual([{ id: "shared-cloud", org: "global", connection: global["shared-cloud"] }]);
  });
});

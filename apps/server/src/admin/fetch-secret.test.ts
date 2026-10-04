import type { TaskId } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { upkeepWorld } from "../captain/upkeep-world.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

vi.setConfig({ testTimeout: 30_000 });

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const VALUE = "pg-pass-7f3a9c1e5b2d4";

/** A captain world with Acme's lane on. Connections: `do` belongs to Acme, `globex-do` to another workspace. */
async function lane() {
  w = await bossWorld({ real: false });
  const { h } = w;
  const { admin, room, secrets } = h.majhi.services;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const runs: { org: string; script: string; connections: readonly string[] }[] = [];
  const held: Record<string, string[]> = { acme: ["do"], globex: ["globex-do"] };
  let output = `${VALUE}\n`;
  admin.useScript({
    run: async (input) => {
      runs.push(input);
      if (output === "boom") throw new Error(`doctl failed for ${VALUE}`);
      return output;
    },
    holds: async (org, id) => held[org]?.includes(id) ?? false,
  });
  const made = await h.cmd("tasks.create", {
    text: "read the OMS database",
    repos: [{ project: "acme-api" }],
    start: false,
  });
  const task = made.body.id as TaskId;
  const ask = (item: string, name: string, label = "the OMS password") =>
    room.post(task, item, { type: "secret-request", agent: "acme-builder", name, label, state: "pending" });
  const call = (tool: string, args: Record<string, unknown>, caller = { task: chat, agent: "boss" }) =>
    admin.call(caller, tool, args);
  const everything = async () =>
    JSON.stringify([await w?.items(task), await w?.items(chat), (await h.cmd("audit.list", {})).body]);
  const pending = () =>
    h.majhi.services.store.room.waitingDecisions().filter((i) => i.type === "secret-request");
  return {
    h,
    chat,
    task,
    runs,
    ask,
    call,
    secrets,
    room,
    everything,
    pending,
    setOutput: (v: string) => {
      output = v;
    },
  };
}

describe("the captain fetching a secret through a connection", () => {
  it("saves the printed value for the request, and the value shows nowhere", async () => {
    const t = await lane();
    t.ask("secret:oms", "oms-ro-password");
    const res = await t.call("majhi_secrets_saveFromScript", {
      task: t.task,
      item: "secret:oms",
      script: 'doctl databases user get "$CLUSTER" ro_user --format Password --no-header',
      connections: ["do"],
    });
    expect(res).toEqual({ text: "Saved as secret:oms-ro-password. The value is not shown.", isError: false });
    expect(await t.secrets.get("oms-ro-password")).toBe(VALUE);
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.org).toBe("acme");
    expect(t.room.get(t.task, "secret:oms")).toMatchObject({ state: "saved" });
    expect(t.pending()).toEqual([]);
    const seen = await t.everything();
    expect(seen).not.toContain(VALUE);
    // The owner sees the script in the room and the audit log.
    expect(seen).toContain("doctl databases user get");
  });

  it("keeps the value out of an error when the script fails", async () => {
    const t = await lane();
    t.ask("secret:oms", "oms-ro-password");
    t.setOutput("boom");
    const res = await t.call("majhi_secrets_saveFromScript", {
      task: t.task,
      item: "secret:oms",
      script: "doctl databases user get x ro_user",
      connections: ["do"],
    });
    expect(res.isError).toBe(true);
    expect(await t.secrets.get("oms-ro-password")).toBeUndefined();
    expect(t.pending()).toHaveLength(1);
  });

  it("never uses another workspace's connection", async () => {
    const t = await lane();
    t.ask("secret:oms", "oms-ro-password");
    const res = await t.call("majhi_secrets_saveFromScript", {
      task: t.task,
      item: "secret:oms",
      script: "doctl databases list",
      connections: ["globex-do"],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("no connection globex-do");
    expect(t.runs).toEqual([]);
    expect(await t.secrets.get("oms-ro-password")).toBeUndefined();
  });

  it("refuses a request of another workspace, a script that writes, and a caller that is no captain", async () => {
    const t = await lane();
    const other = (await t.h.cmd("tasks.create", { text: "the owner's own", start: false })).body
      .id as TaskId;
    t.room.post(other, "secret:own", {
      type: "secret-request",
      agent: "someone",
      name: "own-key",
      label: "a key",
      state: "pending",
    });
    const foreign = await t.call("majhi_secrets_saveFromScript", {
      task: other,
      item: "secret:own",
      script: "echo hi",
      connections: [],
    });
    expect(foreign.text).toContain("another workspace");
    t.ask("secret:oms", "oms-ro-password");
    const writes = await t.call("majhi_secrets_saveFromScript", {
      task: t.task,
      item: "secret:oms",
      script: "curl -X POST https://api.example/keys",
      connections: [],
    });
    expect(writes.text).toContain("only reads");
    const agent = await t.call(
      "majhi_secrets_saveFromScript",
      { task: t.task, item: "secret:oms", script: "echo hi", connections: [] },
      { task: t.task, agent: "acme-builder" },
    );
    expect(agent.text).toContain("captain's tool");
    expect(t.runs).toEqual([]);
    expect(await t.secrets.get("oms-ro-password")).toBeUndefined();
  });

  it("does not overwrite a secret that exists", async () => {
    const t = await lane();
    await t.secrets.set("oms-ro-password", "old-value");
    const res = await t.call("majhi_secrets_saveFromScript", {
      name: "oms-ro-password",
      script: "echo hi",
      connections: [],
    });
    expect(res.text).toContain("exists already");
    expect(await t.secrets.get("oms-ro-password")).toBe("old-value");
  });

  it("withdraws a request and it leaves Needs you", async () => {
    const t = await lane();
    t.ask("secret:oms", "oms-ro-password");
    expect(t.pending()).toHaveLength(1);
    const res = await t.call("majhi_secrets_withdrawRequest", {
      task: t.task,
      item: "secret:oms",
      reason: "the URL request covers it",
    });
    expect(res.isError).toBe(false);
    expect(t.room.get(t.task, "secret:oms")).toMatchObject({ state: "cancelled" });
    expect(t.pending()).toEqual([]);
  });
});

describe("tidying secret requests", () => {
  it("collapses requests for the same secret into the oldest", async () => {
    const t = await lane();
    t.ask("secret:a", "oms-ro-url", "the OMS URL");
    t.ask("secret:b", "oms-ro-url", "the OMS URL again");
    t.ask("secret:c", "nbr-ro-url", "the NBR URL");
    const upkeep = upkeepWorld({
      run: async () => ({ output: [] }),
      store: t.h.majhi.services.store,
      now: () => new Date(),
    });
    const stale = await upkeep.staleSecrets("acme");
    expect(stale.map((s) => s.item)).toEqual(["secret:b"]);
    expect(stale[0]?.obsolete).toContain("already asks for the same secret:oms-ro-url");
    expect(await upkeep.pendingSecrets?.("acme")).toEqual([
      `${t.task}/secret:a`,
      `${t.task}/secret:b`,
      `${t.task}/secret:c`,
    ]);
  });
});

import type { CrmGet, CrmList, KbList, KbUpsertResult } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { captainScript } from "../testing/captainScript.ts";

/** Real captain turns, scripted through the fake agent, read and propose business memory inside one workspace. */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const PII = "dana.private@globex.example";

async function lane() {
  w = await bossWorld();
  const { h } = w;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  expect((await h.cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" })).status).toBe(200);
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  return { w, h, chat };
}

describe("business memory through a captain turn", () => {
  it("reads its own workspace and the business, proposes an unverified entry, and cannot reach Globex", async () => {
    const { w: world, h, chat } = await lane();
    const seed = async (name: string, input: Record<string, unknown>) => {
      const done = await h.cmd(name as never, input as never);
      expect(done.status).toBe(200);
      return done.body;
    };
    await seed("kb.upsert", { kind: "about", title: "Business about", body: "We make river boats." });
    await seed("kb.upsert", {
      kind: "pricing",
      title: "Acme pricing",
      body: "Starter boats cost 20.",
      org: "acme",
    });
    await seed("kb.upsert", {
      kind: "metric",
      title: "Globex margin",
      body: "Globex boat margin is 41 percent.",
      org: "globex",
    });
    await seed("crm.upsert", {
      name: "Acme buyer",
      relation: "client",
      org: "acme",
      emails: ["buyer@acme.example"],
    });
    const globexPerson = (await seed("crm.upsert", { name: "Dana", org: "globex", emails: [PII] })) as {
      contact: { id: number };
    };
    await seed("crm.upsert", { name: "Owner friend", ownerOnly: true, emails: ["friend@home.example"] });

    const seen: string[] = [];
    const script = await captainScript(
      world,
      [
        {
          when: /Wake: business/,
          steps: [
            { tool: "majhi_kb_list", args: { org: "globex", reason: "look" } },
            { tool: "majhi_kb_search", args: { query: "boat margin percent", reason: "search" } },
            { tool: "majhi_crm_list", args: { reason: "people" } },
            { tool: "majhi_crm_get", args: { id: globexPerson.contact.id, reason: "reach" } },
            {
              tool: "majhi_kb_upsert",
              args: {
                kind: "win",
                title: "Shipped the river tour",
                body: "The tour shipped on time.",
                reason: "from a shipped task",
              },
            },
            { tool: "majhi_kb_remove", args: { id: 1, reason: "tidy" } },
            { tool: "majhi_voice_set", args: { tone: "Loud.", reason: "mine" } },
            { say: "Done." },
          ],
        },
      ],
      { task: chat, onResult: (r) => seen.push(r.text) },
    );
    await h.majhi.services.lanes.tell("acme", "Wake: business sweep", "wake");
    const calls = await script.calls(7);

    // Globex is out of reach, the owner's own contact is hidden, and the owner-only tools are not tools.
    expect(calls[0]?.isError).toBe(true);
    expect(calls[3]?.isError).toBe(true);
    expect(calls[5]?.isError).toBe(true);
    expect(calls[6]?.isError).toBe(true);
    expect(seen.join("\n")).not.toContain("Globex boat margin");
    expect(seen.join("\n")).not.toContain(PII);
    expect(seen.join("\n")).not.toContain("friend@home.example");
    expect(seen[1] ?? "").toContain("river boats".slice(0, 4));
    expect(seen[1] ?? "").not.toContain("41 percent");
    expect(seen[2] ?? "").toContain("Acme buyer");
    expect(seen[2] ?? "").not.toContain("Owner friend");

    // What it proposed waits, unverified, in Acme.
    const mine = (await h.cmd("kb.list", { org: "acme" })).body as KbList;
    const proposal = mine.entries.find((e) => e.title === "Shipped the river tour");
    expect(proposal).toMatchObject({ org: "acme", verified: false, by: "captain" });
    // Nothing of the owner's changed.
    const all = (await h.cmd("kb.list", {})).body as KbList;
    expect(all.total).toBe(4);
    expect(all.entries.find((e) => e.title === "Business about")?.verified).toBe(true);
    const globex = (await h.cmd("crm.get", { id: globexPerson.contact.id })).body as CrmGet;
    expect(globex.contact.emails).toEqual([PII]);
  });

  it("keeps a contact and its data out of every table outside the business tables, and out of other tasks' rooms", async () => {
    const { w: world, h, chat } = await lane();
    const secret = "lena.private@acme.example";
    const script = await captainScript(
      world,
      [
        {
          when: /Wake: people/,
          steps: [
            {
              tool: "majhi_crm_upsert",
              args: {
                name: "Lena Private",
                emails: [secret],
                notes: "Prefers calls.",
                reason: "new lead from the inbox",
              },
            },
            { tool: "majhi_crm_list", args: { reason: "check" } },
            { say: "Added." },
          ],
        },
      ],
      { task: chat },
    );
    await h.majhi.services.lanes.tell("acme", "Wake: people sweep", "wake");
    await script.calls(2);
    const list = (await h.cmd("crm.list", { org: "acme" })).body as CrmList;
    expect(list.contacts.map((c) => [c.name, c.org, c.by])).toEqual([["Lena Private", "acme", "captain"]]);

    const raw = h.majhi.services.store.raw;
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter(
        (n) => !/^(crm_|kb_|voice_|deadlines)/.test(n) && !n.includes("_fts") && !n.includes("_search"),
      );
    for (const table of tables) {
      // The lane's own thread holds what its tools answered, as for any tool. No other task's room does.
      const rows = JSON.stringify(
        table === "room_items"
          ? raw.prepare("SELECT * FROM room_items WHERE task <> ?").all(chat)
          : raw.prepare(`SELECT * FROM "${table}"`).all(),
      );
      expect(rows, `table ${table}`).not.toContain(secret);
      expect(rows, `table ${table}`).not.toContain("Prefers calls");
    }
  });

  it("answers a bad call with an error the captain can read, and changes nothing", async () => {
    const { w: world, h, chat } = await lane();
    const script = await captainScript(
      world,
      [
        {
          when: /Wake: bad/,
          steps: [
            { tool: "majhi_kb_upsert", args: { kind: "made-up", title: "x", reason: "bad kind" } },
            {
              tool: "majhi_kb_upsert",
              args: { kind: "about", title: "x", body: "a".repeat(40_001), reason: "huge" },
            },
            {
              tool: "majhi_deadlines_upsert",
              args: { kind: "grant", title: "Fund", due: "2026-02-30", reason: "bad date" },
            },
            { say: "Tried." },
          ],
        },
      ],
      { task: chat },
    );
    await h.majhi.services.lanes.tell("acme", "Wake: bad input", "wake");
    const calls = await script.calls(3);
    expect(calls.map((c) => c.isError)).toEqual([true, true, true]);
    expect(((await h.cmd("kb.list", {})).body as KbList).total).toBe(0);
    expect((await h.cmd("deadlines.list", { status: "all" })).body).toEqual({ deadlines: [] });
    const created = (await h.cmd("kb.upsert", { kind: "about", title: "ok" })).body as KbUpsertResult;
    expect(created.created).toBe(true);
  });
});

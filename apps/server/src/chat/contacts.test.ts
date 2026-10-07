import { describe, expect, it } from "vitest";
import { CONN, envelope, world } from "./testing/world.ts";

/** Test 4: a merge is reversible: undo restores both contacts and their identities exactly. */

describe("contacts", () => {
  it("asks whether two contacts are one person and never merges by name alone", async () => {
    const w = world();
    const room = await w.linked();
    await w.ingest.deliver(
      CONN,
      envelope({ message: "2", text: "Hi", sender: { id: "u1", name: "Sara", bot: false, verified: true } }),
    );
    w.contacts.ensure("acme", { app: "slack", account: "acme-workspace", native: "U9" }, "Sara Khan");
    // The second identity appears in the same room as a new contact: the captain asks.
    const second = w.contacts.ensure(
      "acme",
      { app: "telegram", account: CONN.account, native: "u2" },
      "Sara Khan",
    );
    const card = w.contacts.propose(room, second.contact);
    expect(card).toMatchObject({ type: "same-person", state: "asking" });
    expect(w.contacts.list("acme")).toHaveLength(3);
    // Answering "not the same" is remembered: the pair is not asked again. The next pair is asked once.
    w.contacts.answer(room, card?.id ?? "", "not-same");
    const next = w.contacts.propose(room, second.contact);
    expect(next).toMatchObject({ type: "same-person", state: "asking" });
    expect(next?.id).not.toBe(card?.id);
    w.contacts.answer(room, next?.id ?? "", "not-same");
    expect(w.contacts.propose(room, second.contact)).toBeUndefined();
    expect(w.contacts.list("acme")).toHaveLength(3);
  });

  it("puts both contacts back exactly when a merge is undone, and keeps what the kept one gained since", async () => {
    const w = world();
    const room = await w.linked();
    const a = w.contacts.ensure(
      "acme",
      { app: "telegram", account: CONN.account, native: "u1" },
      "Sara",
    ).contact;
    const b = w.contacts.ensure(
      "acme",
      { app: "slack", account: "acme-workspace", native: "U9" },
      "Sara Khan",
    ).contact;
    w.store.client.setUs(b.id, true);
    const before = { a: w.contacts.view(a.id), b: w.contacts.view(b.id) };

    const { merge, contact } = w.contacts.merge(a.id, b.id);
    expect(contact.ids.map((i) => i.native).toSorted()).toEqual(["U9", "u1"]);
    expect(() => w.contacts.view(b.id)).toThrow(/no contact/);
    // Sara is seen in a third place after the merge: that stays with the kept contact on undo.
    w.store.client.addContact(
      { id: "ct-extra", org: "acme", name: "x", us: false },
      { app: "discord", account: "d", native: "D1" },
      new Date().toISOString(),
    );
    w.store.client.rename(a.id, a.name);

    w.contacts.undo(merge, room);
    expect(w.contacts.view(a.id)).toEqual(before.a);
    expect(w.contacts.view(b.id)).toEqual(before.b);
    expect(
      w.store.client.byIdentity("acme", { app: "slack", account: "acme-workspace", native: "U9" })?.id,
    ).toBe(b.id);
    expect(() => w.contacts.undo(merge)).toThrow(/undone already/);
  });

  it("never merges contacts of two workspaces", () => {
    const w = world();
    const a = w.contacts.ensure(
      "acme",
      { app: "telegram", account: CONN.account, native: "u1" },
      "Sara",
    ).contact;
    const b = w.contacts.ensure(
      "globex",
      { app: "telegram", account: CONN.account, native: "u1" },
      "Sara",
    ).contact;
    expect(a.id).not.toBe(b.id);
    expect(() => w.contacts.merge(a.id, b.id)).toThrow(/two workspaces/);
    expect(w.contacts.view(a.id).ids).toHaveLength(1);
    expect(w.contacts.view(b.id).ids).toHaveLength(1);
  });
});

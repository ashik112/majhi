import { randomUUID } from "node:crypto";
import {
  CHAT_APP_LABEL,
  type ChatApp,
  type Contact,
  type ContactIdentity,
  type ContactView,
  type RoomItem,
  type TaskId,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";

export interface ContactsDeps {
  store: Store;
  room: Pick<RoomService, "post" | "get">;
  changed: () => void;
  now?: () => Date;
}

/** A name as words, lower case: how two names are compared. */
export function wordsOf(name: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const ch of `${name.toLowerCase()} `) {
    if (ch.toLowerCase() !== ch.toUpperCase() || (ch >= "0" && ch <= "9")) word += ch;
    else if (word !== "") {
      out.push(word);
      word = "";
    }
  }
  return out;
}

/**
 * Whether two names may be one person: the same words, or the shorter one is the start of the longer ("Sara" and
 * "Sara Khan"). It only proposes. Nothing is merged because names look alike.
 */
export function maybeSamePerson(a: string, b: string): boolean {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length === 0 || (short[0] ?? "").length < 2) return false;
  return short.every((word, i) => long[i] === word);
}

function appOf(contact: ContactView): string {
  const first = contact.ids[0];
  return first === undefined ? "a chat" : CHAT_APP_LABEL[first.app as ChatApp];
}

/**
 * Contacts: who the clients are. A contact is one person in one workspace with the chat identities they have
 * (an app account and the app's own user id). Identity is the user id, never the name. A merge is the owner's
 * answer to a card and is logged, so it can be undone with both contacts exactly as they were.
 */
export class Contacts {
  constructor(private readonly deps: ContactsDeps) {}

  private at(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** The contact of a chat identity in a workspace, made on first sight. `fresh` is true when it was made now. */
  ensure(org: string, identity: ContactIdentity, name: string): { contact: Contact; fresh: boolean } {
    const had = this.deps.store.client.byIdentity(org, identity);
    if (had !== undefined) {
      // The handle an app shows can change: the latest one is kept.
      this.deps.store.client.setUsername(org, identity, identity.username);
      return { contact: had, fresh: false };
    }
    const contact: Contact = {
      id: `ct-${randomUUID().slice(0, 8)}`,
      org,
      name: name === "" ? "Unknown" : name,
      us: false,
    };
    const made = this.deps.store.client.addContact(contact, identity, this.at());
    return { contact: made, fresh: made.id === contact.id };
  }

  view(id: string): ContactView {
    const found = this.deps.store.client.view(id);
    if (found === undefined) throw new UserError(`There is no contact ${id}.`, 404);
    return found;
  }

  list(org: string): ContactView[] {
    return this.deps.store.client.contactsOf(org);
  }

  setUs(id: string, us: boolean): void {
    this.view(id);
    this.deps.store.client.setUs(id, us);
    this.deps.changed();
  }

  /**
   * Asks the owner whether a new contact is one the workspace has already, in the room the person wrote in. One card
   * per pair, ever: an answered pair is not asked again.
   */
  propose(room: string, fresh: Contact): RoomItem | undefined {
    const { client } = this.deps.store;
    for (const other of client.contactsOf(fresh.org)) {
      if (other.id === fresh.id || other.us) continue;
      if (!maybeSamePerson(other.name, fresh.name)) continue;
      if (client.pairAsked(other.id, fresh.id)) continue;
      const here = this.view(fresh.id);
      const line = `${other.name} on ${appOf(other)} and ${fresh.name} on ${appOf(here)}: same person?`;
      const id = `same:${other.id}:${fresh.id}`;
      this.deps.room.post(room as TaskId, id, {
        type: "same-person",
        a: other.id,
        b: fresh.id,
        line,
        state: "asking",
      });
      this.deps.changed();
      return this.deps.room.get(room, id);
    }
    return undefined;
  }

  /** The owner's answer to a same-person card. */
  answer(room: string, item: string, answer: "same" | "not-same"): RoomItem {
    const card = this.deps.room.get(room, item);
    if (card?.type !== "same-person") throw new UserError("That is not a same-person question.", 404);
    if (card.state !== "asking") throw new UserError("That was answered already.", 409);
    let merge: number | undefined;
    if (answer === "same") merge = this.merge(card.a, card.b).merge;
    this.deps.room.post(room as TaskId, card.id, {
      type: "same-person",
      a: card.a,
      b: card.b,
      line: card.line,
      state: answer,
      ...(merge === undefined ? {} : { merge }),
    });
    return this.deps.room.get(room, item) ?? card;
  }

  /** Folds `merge` into `keep`. Both are in one workspace. Returns the merge's id, for Undo. */
  merge(keep: string, merge: string): { merge: number; contact: ContactView } {
    const a = this.deps.store.client.contact(keep);
    const b = this.deps.store.client.contact(merge);
    if (a === undefined || b === undefined) throw new UserError("One of the contacts is gone.", 404);
    if (a.org !== b.org) throw new UserError("Contacts of two workspaces are never merged.", 409);
    if (a.id === b.id) throw new UserError("That is one contact.", 409);
    const id = this.deps.store.client.merge(keep, merge, this.at());
    this.deps.changed();
    return { merge: id, contact: this.view(keep) };
  }

  /** Puts both contacts back as they were before the merge. */
  undo(merge: number, room?: string): void {
    const record = this.deps.store.client.mergeRecord(merge);
    if (record === undefined) throw new UserError(`There is no merge ${merge}.`, 404);
    if (record.undoneAt !== undefined) throw new UserError("That merge was undone already.", 409);
    this.deps.store.client.undoMerge(merge, this.at());
    if (room !== undefined) {
      const cards = this.deps.store.room
        .page(room, 200)
        .items.filter((i) => i.type === "same-person" && i.merge === merge);
      for (const card of cards) {
        if (card.type !== "same-person") continue;
        // The owner said same, then took it back: that is Not same, and the pair is not asked again.
        this.deps.room.post(room as TaskId, card.id, {
          type: "same-person",
          a: card.a,
          b: card.b,
          line: card.line,
          state: "not-same",
        });
      }
    }
    this.deps.changed();
  }
}

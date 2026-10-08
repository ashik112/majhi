import { mentionLabel, mentionToken, type RoomItem, replaceMentions } from "@majhi/shared";
import type { RoomRow } from "../store/client.ts";
import type { Store } from "../store/index.ts";

export type ClientItem = Extract<RoomItem, { type: "client" }>;

/** One line, cut to fit. */
export function clip(text: string, max: number): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A client text as the captain reads it: a mention is `@Sara (Acme)`, the contact's name and the chat's. */
export function readable(
  room: RoomRow,
  item: { text: string; mentions?: Record<string, string> | undefined },
): string {
  return replaceMentions(item.text, (id) => mentionLabel(item.mentions?.[id] ?? "someone", room.chat.title));
}

/** Client text as quoted data: it cannot close the tag it sits in. */
export const fenced = (text: string): string => text.split("<").join("&lt;");

/** An attribute value: no quote or bracket ends it early. */
export const attr = (text: string): string => fenced(text).split('"').join("&quot;");

/**
 * The people who wrote in a chat, with the contact id that mentions each: `Sara = @[contact:ct-1a2b3c4d]`. The
 * captain gets this with every message of the chat, so it can mention someone back.
 */
export function peopleLine(store: Store, room: RoomRow): string {
  const org = room.org;
  if (org === undefined) return "People in this chat: none known yet.";
  const seen = new Map<string, string>();
  for (const item of store.room.page(room.id, 200).items) {
    if (item.type !== "client" || !item.sender.verified) continue;
    const contact = store.client.byIdentity(org, {
      app: item.external.app,
      account: item.external.account,
      native: item.sender.id,
    });
    if (contact !== undefined && !seen.has(contact.id)) seen.set(contact.id, contact.name);
  }
  if (seen.size === 0) return "People in this chat: none known yet.";
  const list = [...seen].map(([id, name]) => `${name} = ${mentionToken(id)}`).join("; ");
  return `People in this chat (write the token to mention one): ${list}`;
}

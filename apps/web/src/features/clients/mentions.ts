import { type ContactView, mentionName, mentionToken, type RoomItem, replaceMentions } from "@majhi/shared";

/** A person a reply can mention: the contact's id and the name the owner sees. */
export interface Person {
  id: string;
  name: string;
}

/**
 * The people of one chat: contacts who wrote in it (matched by their chat identity), and anyone a message or reply of
 * the chat already mentions.
 */
export function roomPeople(
  items: readonly RoomItem[],
  contacts: readonly ContactView[] | undefined,
): Person[] {
  const found = new Map<string, string>();
  for (const item of items) {
    if (item.type === "client" || item.type === "client-reply") {
      for (const [id, name] of Object.entries(item.mentions ?? {})) found.set(id, name);
    }
    if (item.type !== "client" || !item.sender.verified) continue;
    const contact = contacts?.find((c) =>
      c.ids.some(
        (i) =>
          i.app === item.external.app && i.account === item.external.account && i.native === item.sender.id,
      ),
    );
    if (contact !== undefined) found.set(contact.id, contact.name);
  }
  return [...found].map(([id, name]) => ({ id, name }));
}

/** A reply as the owner edits it: each mention token is `@Name`. */
export function tokensToNames(text: string, people: readonly Person[]): string {
  return replaceMentions(text, (id) => `@${mentionName(id, undefined, (c) => people.find((p) => p.id === c)?.name)}`);
}

const isWordChar = (ch: string): boolean => ch.toLowerCase() !== ch.toUpperCase() || (ch >= "0" && ch <= "9");

/** What the owner typed, with each `@Name` of a person of the chat turned back into its token. */
export function namesToTokens(text: string, people: readonly Person[]): string {
  const byLength = people.toSorted((a, b) => b.name.length - a.name.length);
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) === "@") {
      const person = byLength.find(
        (p) => text.startsWith(p.name, i + 1) && !isWordChar(text.charAt(i + 1 + p.name.length)),
      );
      if (person !== undefined) {
        out += mentionToken(person.id);
        i += 1 + person.name.length;
        continue;
      }
    }
    out += text.charAt(i);
    i += 1;
  }
  return out;
}

/** The `@query` the caret is in: where the @ is and what is typed after it, or nothing. */
export function mentionQuery(text: string, caret: number): { at: number; query: string } | undefined {
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = text.charAt(i);
    if (ch === "@") {
      const before = text.charAt(i - 1);
      const starts = i === 0 || before === " " || before === "\n";
      return starts ? { at: i, query: text.slice(i + 1, caret) } : undefined;
    }
    if (ch.trim() === "") return undefined;
  }
  return undefined;
}

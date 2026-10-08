import { z } from "zod";

/**
 * The one neutral body of everything majhi writes to a client chat: paragraphs with bold, italic, code, links and
 * mentions, code blocks and lists. The captain writes a small Markdown subset; it is parsed once into this
 * (`apps/server/src/chat/format.ts`) and each chat app renders it in its own markup. A mention names a contact by
 * id, so each app can show the person the way it knows them.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "bold"; children: Inline[] }
  | { t: "italic"; children: Inline[] }
  | { t: "code"; text: string }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "mention"; contact: string };

export type Block =
  | { t: "paragraph"; children: Inline[] }
  | { t: "codeBlock"; text: string; lang?: string | undefined }
  | { t: "list"; ordered: boolean; items: Inline[][] };

export type Body = Block[];

export const InlineSchema: z.ZodType<Inline> = z.lazy(() =>
  z.discriminatedUnion("t", [
    z.strictObject({ t: z.literal("text"), text: z.string() }),
    z.strictObject({ t: z.literal("bold"), children: z.array(InlineSchema) }),
    z.strictObject({ t: z.literal("italic"), children: z.array(InlineSchema) }),
    z.strictObject({ t: z.literal("code"), text: z.string() }),
    z.strictObject({ t: z.literal("link"), href: z.string(), children: z.array(InlineSchema) }),
    z.strictObject({ t: z.literal("mention"), contact: z.string().min(1) }),
  ]),
);

export const BlockSchema: z.ZodType<Block> = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("paragraph"), children: z.array(InlineSchema) }),
  z.strictObject({ t: z.literal("codeBlock"), text: z.string(), lang: z.string().optional() }),
  z.strictObject({ t: z.literal("list"), ordered: z.boolean(), items: z.array(z.array(InlineSchema)) }),
]);
export const BodySchema: z.ZodType<Body> = z.array(BlockSchema);

/** The token a writer puts in text to mention a contact: `@[contact:ct-1a2b3c4d]`. */
export const MENTION_OPEN = "@[contact:";
const MENTION_CLOSE = "]";

/** A contact id as the token allows it: letters, digits, dash and underscore. */
function isIdChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "-" ||
    ch === "_"
  );
}

export function mentionToken(contact: string): string {
  return `${MENTION_OPEN}${contact}${MENTION_CLOSE}`;
}

/** A piece of text: words, or a mention token's contact id. */
export type TextPart = { text: string } | { mention: string };

/** Splits text at its mention tokens. Scans with `indexOf`: a token with a bad id stays text. */
export function splitMentions(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let from = 0;
  let plain = 0;
  for (;;) {
    const at = text.indexOf(MENTION_OPEN, from);
    if (at === -1) break;
    const start = at + MENTION_OPEN.length;
    let end = start;
    while (end < text.length && isIdChar(text.charAt(end))) end += 1;
    if (end === start || text.charAt(end) !== MENTION_CLOSE) {
      from = at + 1;
      continue;
    }
    if (at > plain) parts.push({ text: text.slice(plain, at) });
    parts.push({ mention: text.slice(start, end) });
    plain = end + 1;
    from = plain;
  }
  if (plain < text.length || parts.length === 0) parts.push({ text: text.slice(plain) });
  return parts;
}

/** The text with every mention token replaced by what `show` says for its contact id. */
export function replaceMentions(text: string, show: (contact: string) => string): string {
  return splitMentions(text)
    .map((p) => ("mention" in p ? show(p.mention) : p.text))
    .join("");
}

/** The contact ids a text mentions, once each. */
export function mentionedContacts(text: string): string[] {
  const ids = splitMentions(text).flatMap((p) => ("mention" in p ? [p.mention] : []));
  return [...new Set(ids)];
}

/** What a chat app says about a mention in a message it delivered: where it is and who it names. */
export const ChatMentionSchema = z.strictObject({
  /** Offsets into the message text, in UTF-16 units (a JS string index). */
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  /** The app's own user id, when the app gives it. */
  native: z.string().max(200).optional(),
  /** The handle, when the app gives it (Telegram `@name`, without the @). */
  username: z.string().max(200).optional(),
});
export type ChatMention = z.infer<typeof ChatMentionSchema>;

/**
 * Mentions in a delivered text become tokens. `find` says which contact a mention names, or nothing, and then the
 * words stay as they were. Returns the new text and the names of the contacts it mentions.
 */
export function tokenizeMentions(
  text: string,
  mentions: readonly ChatMention[],
  find: (mention: ChatMention) => { id: string; name: string } | undefined,
): { text: string; names: Record<string, string> } {
  const names: Record<string, string> = {};
  let out = text;
  let limit = text.length;
  for (const mention of mentions.toSorted((a, b) => b.start - a.start)) {
    // Overlapping or out-of-range spans are skipped: the words stay.
    if (mention.end > limit || mention.start >= mention.end) continue;
    const found = find(mention);
    if (found === undefined) continue;
    out = `${out.slice(0, mention.start)}${mentionToken(found.id)}${out.slice(mention.end)}`;
    names[found.id] = found.name;
    limit = mention.start;
  }
  return { text: out, names };
}

/**
 * A Slack person's identity in majhi: the user id alone. Slack user ids are unique across the workspaces of a
 * connection, so a team prefix adds nothing and, taken per message, split one person into several. Older data
 * wrote `T01:U02` (or `:U02`); this reads those back to the same person.
 */
export function slackPersonId(user: string): string {
  return user.slice(user.lastIndexOf(":") + 1);
}

/** Slack's `<@U123>` and `<@U123|name>` in a text, as mentions with the user id. A pure parser for the Slack adapter. */
export function slackMentions(text: string): ChatMention[] {
  const out: ChatMention[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("<@", from);
    if (at === -1) return out;
    const close = text.indexOf(">", at);
    if (close === -1) return out;
    const inner = text.slice(at + 2, close);
    const bar = inner.indexOf("|");
    const id = bar === -1 ? inner : inner.slice(0, bar);
    if (id !== "" && [...id].every((c) => (c >= "A" && c <= "Z") || (c >= "0" && c <= "9"))) {
      out.push({ start: at, end: close + 1, native: id });
    }
    from = close + 1;
  }
}

/** A mention's text for a reader that has the contact's name: `@Sara`, or `@Sara (Acme)` when a place is given. */
export function mentionLabel(name: string, place?: string): string {
  return place === undefined || place === "" ? `@${name}` : `@${name} (${place})`;
}

/** What a mention reads as when neither the message nor the contact list names the person. */
export const UNKNOWN_MENTION = "contact";

/** The name a mention token shows: the message's own map first, then the contact list, never the id. */
export function mentionName(
  contact: string,
  names?: Readonly<Record<string, string>>,
  lookup?: (contact: string) => string | undefined,
): string {
  return names?.[contact] ?? lookup?.(contact) ?? UNKNOWN_MENTION;
}

/** A text for a preview: every mention token reads `@Name`. */
export function mentionNames(
  text: string,
  names?: Readonly<Record<string, string>>,
  lookup?: (contact: string) => string | undefined,
): string {
  return replaceMentions(text, (id) => `@${mentionName(id, names, lookup)}`);
}

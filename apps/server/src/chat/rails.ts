import {
  type AuthorityChoice,
  detectSecrets,
  type HoldClass,
  type Holds,
  type ReplyFlags,
  type ReplyHold,
} from "@majhi/shared";

/**
 * The rails of a reply to a client (docs/briefs/client-chats.md, "Permission"). Pure: given what the owner set and
 * what is known about the reply, it says whether the captain may send it now or it waits for the owner, and why.
 *
 * Order, first that holds wins:
 *   1. a secret in the text, which is also taken out of it (fixed, no switch);
 *   2. another client's or another workspace's name in the text (fixed);
 *   3. a report to a client, such as an RCA (fixed);
 *   4. Auto-pilot off: every reply waits (the one rule for every client reply, whatever Tell says);
 *   5. Tell on Ask me: every reply waits;
 *   6. under Captain decides, the classes of the Hold list the owner left on.
 * A reply the writer gave no flags for waits: a missing answer is never a yes.
 */

export interface RailsInput {
  /** The workspace's Tell row as it is now (Ask me while Auto-pilot is not On). */
  tell: AuthorityChoice;
  holds: Holds;
  text: string;
  /** What the writer says of the text. Absent: the reply waits. */
  flags: ReplyFlags | undefined;
  /** Names that must not appear: other clients' chats and contacts, other workspaces. */
  others: readonly string[];
  /** No reply was ever sent to the person this answers. */
  firstContact: boolean;
  /** Messages are missing in this chat since the owner or a teammate last wrote. */
  afterGap: boolean;
  /** The text is a report, like an RCA. */
  report?: boolean;
  /** Auto-pilot is on. While it is off, every reply waits for the owner. */
  autopilot: boolean;
}

export type RailsVerdict =
  | { send: true; text: string }
  | { send: false; why: ReplyHold /** The text as it is kept: a secret is taken out. */; text: string };

const REMOVED = "[removed]";

/** The text with every secret it holds replaced. */
export function withoutSecrets(text: string): string {
  const found = detectSecrets(text).toSorted((a, b) => b.start - a.start);
  let out = text;
  for (const secret of found) out = `${out.slice(0, secret.start)}${REMOVED}${out.slice(secret.end)}`;
  return out;
}

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return ch.toLowerCase() !== ch.toUpperCase() || (ch >= "0" && ch <= "9");
}

/** Whether `name` is in `text` as a whole word or phrase, ignoring case. */
export function mentionsName(text: string, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (needle.length < 3) return false;
  const hay = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;
    if (!isWordChar(hay[at - 1]) && !isWordChar(hay[at + needle.length])) return true;
    from = at + 1;
  }
}

export function railsFor(input: RailsInput): RailsVerdict {
  const clean = withoutSecrets(input.text);
  if (clean !== input.text) return { send: false, why: "secret", text: clean };
  if (input.others.some((name) => mentionsName(input.text, name))) {
    return { send: false, why: "other-client", text: input.text };
  }
  if (input.report === true) return { send: false, why: "report", text: input.text };
  if (!input.autopilot) return { send: false, why: "autopilot", text: input.text };
  if (input.tell !== "decide") return { send: false, why: "tell", text: input.text };
  const flags = input.flags;
  const held = (why: HoldClass): RailsVerdict => ({ send: false, why, text: input.text });
  if (flags === undefined) return { send: false, why: "unchecked", text: input.text };
  if (input.holds.promisedTime && flags.promisedTime) return held("promisedTime");
  if (input.holds.money && flags.money) return held("money");
  if (input.holds.security && flags.security) return held("security");
  if (input.holds.severalClients && flags.severalClients) return held("severalClients");
  if (input.holds.firstContact && input.firstContact) return held("firstContact");
  if (input.holds.afterGap && input.afterGap) return held("afterGap");
  return { send: true, text: input.text };
}

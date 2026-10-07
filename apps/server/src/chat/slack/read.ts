import { type ChatMention, slackPersonId } from "@majhi/shared";

/**
 * Reading what Slack sends. A Slack `ts` is the message's id and its time: seconds, a dot and six digits, as a string.
 * A float would lose the last digits, so two of them are compared as numbers only after they are cut at the dot.
 */

/** Negative when `a` is earlier than `b`. */
export function compareTs(a: string, b: string): number {
  const [aSec = "", aRest = ""] = a.split(".");
  const [bSec = "", bRest = ""] = b.split(".");
  if (aSec.length !== bSec.length) return aSec.length - bSec.length;
  if (aSec !== bSec) return aSec < bSec ? -1 : 1;
  const x = aRest.padEnd(6, "0");
  const y = bRest.padEnd(6, "0");
  return x === y ? 0 : x < y ? -1 : 1;
}

export function laterTs(a: string | undefined, b: string): string {
  return a === undefined || compareTs(a, b) < 0 ? b : a;
}

/** A ts just before this one: reading from it includes the message itself. */
export function beforeTs(ts: string): string {
  const [sec = "0", micro = "0"] = ts.split(".");
  const n = Number(micro.padEnd(6, "0"));
  if (n > 0) return `${sec}.${String(n - 1).padStart(6, "0")}`;
  return `${Number(sec) - 1}.999999`;
}

/** The time a `ts` stands for. */
export function tsToIso(ts: string): string {
  const seconds = Number(ts.split(".")[0] ?? "0");
  return new Date((Number.isFinite(seconds) ? seconds : 0) * 1000).toISOString();
}

function after(value: string, from: number, ch: string): number {
  return value.indexOf(ch, from);
}

/**
 * A Slack message text as words, with the people it names as mentions of the text that is returned. Slack writes a
 * person as `<@U123>`, a link as `<https://x|label>`, a channel as `<#C1|name>`, and escapes `&`, `<` and `>`.
 * `names` gives the display name of a user id; a person with no name stays their id.
 */
export function readSlackText(
  raw: string,
  names: (user: string) => string | undefined,
): { text: string; mentions: ChatMention[] } {
  let out = "";
  const mentions: ChatMention[] = [];
  let from = 0;
  const plain = (segment: string): string =>
    segment.split("&lt;").join("<").split("&gt;").join(">").split("&amp;").join("&");
  for (;;) {
    const open = after(raw, from, "<");
    const close = open === -1 ? -1 : after(raw, open, ">");
    if (open === -1 || close === -1) {
      out += plain(raw.slice(from));
      break;
    }
    out += plain(raw.slice(from, open));
    from = close + 1;
    const inner = raw.slice(open + 1, close);
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    const label = bar === -1 ? undefined : inner.slice(bar + 1);
    if (target.startsWith("@")) {
      const id = target.slice(1);
      const word = `@${names(id) ?? (label !== undefined && label !== "" ? label : id)}`;
      if (id !== "")
        mentions.push({ start: out.length, end: out.length + word.length, native: slackPersonId(id) });
      out += word;
    } else if (target.startsWith("#")) {
      out += `#${label !== undefined && label !== "" ? label : target.slice(1)}`;
    } else if (target.startsWith("!")) {
      const word = target.slice(1);
      const special = word === "here" || word === "channel" || word === "everyone";
      out += label !== undefined && label !== "" ? label : special ? `@${word}` : word;
    } else if (label !== undefined && label !== "" && label !== target) {
      out += `${plain(label)} (${target})`;
    } else {
      out += target;
    }
  }
  return { text: out, mentions };
}

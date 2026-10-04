/**
 * Reading a public feed: RSS, Atom or JSON (JSON Feed, or a plain list). Everything here is defensive,
 * because a feed is third-party text. A page that is HTML, garbage, or too big yields no items and a
 * reason, never an exception. The parser does no network, runs no script, and resolves no entity but
 * the basic ones, so a hostile document cannot make it fetch or expand anything.
 */

export interface FeedItem {
  /** The feed's own id for it, or its link, or its title. */
  id: string;
  title: string;
  url: string | undefined;
  /** Plain text, tags removed, cut short. */
  summary: string;
  published: string | undefined;
  /** A deadline the item states, `YYYY-MM-DD`. */
  deadline: string | undefined;
}

export type FeedRead = { ok: true; items: FeedItem[] } | { ok: false; why: string };

export const MAX_ITEMS = 100;
const TITLE_CHARS = 200;
const SUMMARY_CHARS = 600;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X")) {
      const code = Number.parseInt(e.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    if (e.startsWith("#")) {
      const code = Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text with tags, control characters and runs of space removed, and cut to a length. */
export function plain(text: string, max: number): string {
  const strip = (t: string): string =>
    t
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ");
  // Entities are decoded after the first strip, so `&lt;script&gt;` arrives as text; the second strip and
  // the removal of stray angle brackets make sure no markup survives either way.
  const cleaned = strip(decode(strip(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))))
    .replace(/[<>]/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m?.[1];
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)];
  const pick = links.find((l) => /rel=["']alternate["']/i.test(l[1] ?? "")) ?? links.find((l) => !/rel=/i.test(l[1] ?? ""));
  const href = pick === undefined ? undefined : /href=["']([^"']+)["']/i.exec(pick[1] ?? "")?.[1];
  return href === undefined ? undefined : decode(href);
}

/** An http or https address, or undefined. Anything else (a javascript: link, a data: link) is dropped. */
export function safeUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const u = new URL(decode(raw).trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function isoDay(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function validDay(y: number, m: number, d: number): string | undefined {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : undefined;
}

const CUE =
  /\b(?:deadline|due(?: date)?|closes?|closing(?: date)?|apply by|applications? (?:close|due)|submissions? (?:close|due)|register by|entries close|ends?)\b[^0-9a-z]{0,12}/gi;

/**
 * A deadline an item's text states: a cue word ("deadline", "closes", "apply by") followed by a date,
 * 2026-11-15 or Nov 15, 2026 or 15 November 2026. The first such date. Dates with no cue are not read:
 * a launch date or an event date is not a deadline.
 */
export function findDeadline(text: string): string | undefined {
  for (const cue of text.matchAll(CUE)) {
    const rest = text.slice((cue.index ?? 0) + cue[0].length, (cue.index ?? 0) + cue[0].length + 40);
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(rest);
    if (iso) {
      const day = validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
      if (day !== undefined) return day;
    }
    const dm = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})/i.exec(rest);
    if (dm) {
      const month = MONTHS.findIndex((m) => m.startsWith((dm[2] ?? "").toLowerCase().slice(0, 3)));
      if (month >= 0) {
        const day = validDay(Number(dm[3]), month + 1, Number(dm[1]));
        if (day !== undefined) return day;
      }
    }
    const md = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(rest);
    if (md) {
      const month = MONTHS.findIndex((m) => m.startsWith((md[1] ?? "").toLowerCase().slice(0, 3)));
      if (month >= 0) {
        const day = validDay(Number(md[3]), month + 1, Number(md[2]));
        if (day !== undefined) return day;
      }
    }
  }
  return undefined;
}

function item(
  fields: {
    id?: string | undefined;
    title: string | undefined;
    url: string | undefined;
    summary: string | undefined;
    published: string | undefined;
    deadline?: string | undefined;
  },
): FeedItem | undefined {
  const title = plain(fields.title ?? "", TITLE_CHARS);
  if (title === "") return undefined;
  const summary = plain(fields.summary ?? "", SUMMARY_CHARS);
  const url = safeUrl(fields.url);
  const explicit = fields.deadline === undefined ? undefined : /^\d{4}-\d{2}-\d{2}/.exec(fields.deadline)?.[0];
  return {
    id: plain(fields.id ?? url ?? title, 300),
    title,
    url,
    summary,
    published: isoDay(fields.published),
    deadline: explicit ?? findDeadline(`${title}. ${summary}`),
  };
}

function fromXml(body: string): FeedItem[] {
  const blocks = [...body.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const out: FeedItem[] = [];
  for (const block of blocks.slice(0, MAX_ITEMS)) {
    const made = item({
      id: tag(block, "guid") ?? tag(block, "id"),
      title: tag(block, "title"),
      url: tag(block, "link")?.trim() || atomLink(block),
      summary: tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content:encoded") ?? tag(block, "content"),
      published: plain(tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "dc:date") ?? "", 60),
    });
    if (made !== undefined) out.push(made);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fromJson(data: unknown): FeedItem[] | undefined {
  let list: unknown;
  if (Array.isArray(data)) list = data;
  else if (typeof data === "object" && data !== null) {
    const o = data as Record<string, unknown>;
    list = o.items ?? o.results ?? o.data ?? o.opportunities ?? o.hackathons ?? o.grants;
  }
  if (!Array.isArray(list)) return undefined;
  const out: FeedItem[] = [];
  for (const raw of list.slice(0, MAX_ITEMS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const made = item({
      id: str(o.id) ?? (typeof o.id === "number" ? String(o.id) : undefined),
      title: str(o.title) ?? str(o.name),
      url: str(o.url) ?? str(o.link) ?? str(o.external_url),
      summary: str(o.summary) ?? str(o.description) ?? str(o.content_text) ?? str(o.content_html),
      published: str(o.date_published) ?? str(o.published) ?? str(o.created_at) ?? str(o.date),
      deadline: str(o.deadline) ?? str(o.closes) ?? str(o.closing_date) ?? str(o.end_date) ?? str(o.date_expires),
    });
    if (made !== undefined) out.push(made);
  }
  return out;
}

/** What a feed answer holds. `contentType` helps tell JSON from XML; the body decides. */
export function parseFeed(body: string, contentType: string): FeedRead {
  const text = body.replace(/^﻿/, "").trim();
  if (text === "") return { ok: false, why: "the feed is empty" };
  if (/^<!doctype html|^<html[\s>]/i.test(text) || /text\/html/i.test(contentType)) {
    return { ok: false, why: "the address returns a web page, not a feed" };
  }
  if (text.startsWith("{") || text.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, why: "the feed is not valid JSON" };
    }
    const items = fromJson(data);
    return items === undefined ? { ok: false, why: "the JSON has no list of items" } : { ok: true, items };
  }
  if (text.startsWith("<")) {
    if (!/<(rss|feed|rdf:RDF)\b/i.test(text)) return { ok: false, why: "the document is not an RSS or Atom feed" };
    return { ok: true, items: fromXml(text) };
  }
  return { ok: false, why: "the answer is not a feed" };
}

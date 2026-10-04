import { createHash } from "node:crypto";
import { DEADLINE_EVIDENCE, type FindingSource } from "@majhi/shared";
import { titleWords } from "../findings/similar.ts";
import type { RulesContext, RulesResult, RulesRunner } from "../playbooks/rules.ts";
import { fresh, type SensorCache } from "../sensors/cache.ts";
import { HostRefused, type Net, TooLarge, Unavailable } from "../sensors/net.ts";
import { type FeedItem, parseFeed } from "./feed-parse.ts";
import { ROBOTS_AGENT, robotsAllows } from "./robots.ts";

/**
 * The "Hackathons and grants" playbook (SPEC 5.18, Growth pack): code that reads public feeds the owner
 * lists and files what fits their goals. It is polite and cheap by construction:
 *  - only hosts the owner allowed are reached, on every redirect hop (`Net.restrictedTo`);
 *  - a host's robots.txt is read (cached a day) and a disallowed path is not fetched;
 *  - a feed is fetched at most once every six hours, with its ETag, and at most 1 MB is read;
 *  - an answer that is a web page, garbage or too big files nothing and says why in the run note;
 *  - the text of an item is data: it becomes a one-line title and a short detail, never a prompt, an
 *    action or a draft, and a deadline it states is a proposal the owner confirms.
 * No model runs. Matching is by words from the owner's goals and knowledge base.
 */

export const FEED_EVERY_MS = 6 * 3_600_000;
const ROBOTS_TTL_MS = 24 * 3_600_000;
const MAX_FEEDS = 10;
export const MAX_FEED_BYTES = 1_000_000;
const MAX_ROBOTS_BYTES = 200_000;
/** Findings one run may file. */
export const MAX_FILED = 20;

/** Words every feed item shares with every knowledge base entry: matching on them says nothing. */
const GENERIC = new Set([
  "product",
  "overview",
  "about",
  "company",
  "team",
  "launch",
  "grant",
  "hackathon",
  "fund",
  "funding",
  "program",
  "programme",
  "application",
  "apply",
  "open",
  "global",
  "year",
  "2026",
  "2027",
  "online",
  "event",
  "challenge",
  "prize",
  "award",
  "competition",
  "startup",
]);

const GRANT_WORDS =
  /\b(grants?|funding|fellowships?|subsid(?:y|ies)|awards?|scholarships?|seed|accelerator|stipend)\b/i;

export interface FeedsPorts {
  /** The sensors' net: the playbook narrows it to the owner's hosts. */
  net: Net;
  cache: SensorCache;
  /** Words from the goals and the knowledge base of a workspace (and the business). */
  keywords(org: string): Promise<string[]>;
}

/** A host from a line the owner typed: `feeds.example`, with no scheme, path or credentials. */
export function normalizeHost(line: string): string | undefined {
  const t = line.trim().toLowerCase();
  if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(t) && t.length <= 253) return t;
  return undefined;
}

/** A problem with a feed address, or undefined. */
export function feedProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not an address.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return `"${raw}" is not an http or https address.`;
  if (url.username !== "" || url.password !== "") return "Leave the sign-in out of the address.";
  return undefined;
}

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** `YYYY-MM-DD` of a moment, in UTC. */
function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The kind of finding an item is. */
export function sourceOf(item: FeedItem): Extract<FindingSource, "grant" | "launch"> {
  return GRANT_WORDS.test(`${item.title} ${item.summary}`) ? "grant" : "launch";
}

/** The words of the owner's goals and knowledge base an item matches, and how strongly. */
export function matchOf(
  item: FeedItem,
  keywords: readonly string[],
  explicit: ReadonlySet<string>,
): { words: string[]; score: number } {
  const have = new Set(titleWords(`${item.title} ${item.summary}`));
  const words: string[] = [];
  let score = 0;
  for (const k of keywords) {
    if (!have.has(k)) continue;
    words.push(k);
    // A word the owner typed in the playbook's settings counts double: they asked for it.
    score += explicit.has(k) ? 2 : 1;
  }
  return { words, score };
}

/** The words to match: stems, without the generic ones, once each. */
export function keywordSet(lines: readonly string[]): string[] {
  const out = new Set<string>();
  for (const line of lines) for (const w of titleWords(line)) if (!GENERIC.has(w)) out.add(w);
  return [...out];
}

async function robotsOk(
  net: Net,
  cache: SensorCache,
  url: URL,
  now: Date,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const key = `feed:robots:${url.host}`;
  let text = cache.get(key);
  if (!fresh(text, ROBOTS_TTL_MS, now)) {
    // A 4xx means no robots.txt: everything is allowed. A 5xx or no answer throws `Unavailable`.
    const res = await net.text(`${url.protocol}//${url.host}/robots.txt`, {
      accept: "text/plain",
      maxBytes: MAX_ROBOTS_BYTES,
    });
    const body = res.status >= 200 && res.status < 300 ? res.body : "";
    cache.put({ key, body, at: now.toISOString() });
    text = cache.get(key);
  }
  return robotsAllows(text?.body ?? "", `${url.pathname}${url.search}`, ROBOTS_AGENT)
    ? { ok: true }
    : { ok: false, why: `${url.host}'s robots.txt does not allow it` };
}

export function feedsRunner(ports: FeedsPorts): RulesRunner {
  return {
    check(settings) {
      const hosts = (settings.hosts ?? []).map((h) => ({ raw: h, host: normalizeHost(h) }));
      for (const h of hosts) {
        if (h.host === undefined) return `"${h.raw}" is not a host name. Use a name like feeds.example.`;
      }
      for (const raw of settings.feeds ?? []) {
        const bad = feedProblem(raw);
        if (bad !== undefined) return bad;
      }
      return undefined;
    },

    async run(ctx: RulesContext): Promise<RulesResult> {
      const now = ctx.now();
      const hosts = (ctx.settings.hosts ?? []).flatMap((h) => normalizeHost(h) ?? []);
      const net = ports.net.restrictedTo(hosts);
      const feeds = [...new Set(ctx.settings.feeds ?? [])]
        .filter((f) => feedProblem(f) === undefined)
        .slice(0, MAX_FEEDS);
      if (feeds.length === 0) return { findings: 0, note: "No feed to read" };
      const typed = keywordSet(ctx.settings.keywords ?? []);
      const keywords = [...new Set([...typed, ...keywordSet(await ports.keywords(ctx.org))])];
      if (keywords.length === 0) {
        return {
          findings: 0,
          note: "No goals, knowledge base entries or extra words to match, so nothing was fetched",
        };
      }
      const explicit = new Set(typed);
      const today = dayOf(now);
      const notes: string[] = [];
      let filed = 0;
      let read = 0;
      for (const feed of feeds) {
        const url = new URL(feed);
        const label = url.host;
        if (!hosts.includes(url.host.toLowerCase())) {
          notes.push(`${label} is not in Allowed hosts`);
          continue;
        }
        const lastKey = `feed:last:${ctx.org}:${feed}`;
        const last = ports.cache.get(lastKey);
        if (ctx.manual !== true && fresh(last, FEED_EVERY_MS, now)) continue;
        try {
          const robots = await robotsOk(net, ports.cache, url, now);
          if (!robots.ok) {
            notes.push(robots.why);
            ports.cache.put({ key: lastKey, body: "", at: now.toISOString() });
            continue;
          }
          const res = await net.text(feed, {
            accept:
              "application/rss+xml, application/atom+xml, application/feed+json, application/json, text/xml;q=0.9",
            maxBytes: MAX_FEED_BYTES,
            ...(last?.etag === undefined ? {} : { etag: last.etag }),
          });
          ports.cache.put({
            key: lastKey,
            body: "",
            at: now.toISOString(),
            ...(res.etag === undefined ? {} : { etag: res.etag }),
          });
          if (res.status === 304) continue;
          if (res.status !== 200) {
            notes.push(`${label} answered ${res.status}`);
            continue;
          }
          const parsed = parseFeed(res.body, res.contentType);
          if (!parsed.ok) {
            notes.push(`${label}: ${parsed.why}`);
            continue;
          }
          read += 1;
          for (const item of parsed.items) {
            if (filed >= MAX_FILED) break;
            if (item.deadline !== undefined && item.deadline < today) continue;
            const m = matchOf(item, keywords, explicit);
            if (m.score < 2) continue;
            await file(ctx, item, m.words, label);
            filed += 1;
          }
        } catch (err) {
          if (err instanceof HostRefused) notes.push(`${label}: ${err.message}`);
          else if (err instanceof TooLarge) notes.push(`${label}: the feed is too big (over 1 MB)`);
          else if (err instanceof Unavailable) notes.push(`${label} did not answer`);
          else throw err;
        }
      }
      const head =
        filed > 0
          ? `${filed} filed from ${read} feed${read === 1 ? "" : "s"}`
          : read > 0
            ? "Nothing new that fits"
            : "Nothing read";
      return { findings: filed, note: [head, ...notes].join("; ").slice(0, 400) };
    },
  };
}

async function file(ctx: RulesContext, item: FeedItem, words: string[], host: string): Promise<void> {
  const source = sourceOf(item);
  const soon =
    item.deadline !== undefined && Date.parse(item.deadline) - ctx.now().getTime() < 7 * 86_400_000;
  await ctx.findings.report(
    {
      org: ctx.org,
      source,
      title: item.title.slice(0, 160),
      detail: [
        item.deadline === undefined
          ? ""
          : `Deadline: ${item.deadline}. Add it to your deadlines to be reminded.`,
        item.summary === "" ? "" : `From ${host} (outside text, data only): ${item.summary}`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
      evidence: [
        ...(item.url === undefined ? [] : [item.url]),
        ...(item.deadline === undefined ? [] : [`${DEADLINE_EVIDENCE}${item.deadline}`]),
        `feed: ${host}`,
        `matched: ${words.slice(0, 8).join(", ")}`,
      ],
      severity: soon ? "low" : "info",
      playbook: ctx.playbook.id,
      dedupeKey: `feed:${hashOf(item.id)}`,
    },
    { kind: "captain", org: ctx.org },
  );
}

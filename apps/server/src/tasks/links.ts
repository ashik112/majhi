import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment } from "@majhi/shared";
import { errorMessage } from "../errors.ts";

export const LINK_TIMEOUT_MS = 10_000;
export const LINK_MAX_BYTES = 2 * 1024 * 1024;

export interface FetchedLink {
  title: string;
  /** Markdown: a heading, the source, then the page as text. */
  markdown: string;
  truncated: boolean;
}

export interface LinkOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Fetches a page once and reduces it to text. Fails with a plain message on a bad status,
 * a type that is not text, or a timeout. Reads at most 2 MB.
 */
export async function fetchLink(url: string, options: LinkOptions = {}): Promise<FetchedLink> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? LINK_MAX_BYTES;
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? LINK_TIMEOUT_MS),
    redirect: "follow",
    headers: { accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1" },
  });
  if (!res.ok) throw new Error(`The server answered ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const isHtml = type === "text/html" || type === "application/xhtml+xml";
  const isText = type.startsWith("text/") || type === "application/json" || type === "";
  if (!isHtml && !isText) throw new Error(`Cannot read ${type} content`);

  const { text, truncated } = await readLimited(res, maxBytes);
  const title = isHtml ? (htmlTitle(text) ?? url) : url;
  const body = isHtml ? htmlToText(text) : text.trim();
  const note = truncated ? "\n\n(Cut at 2 MB.)" : "";
  return { title, markdown: `# ${title}\n\nSource: ${url}\n\n${body}${note}\n`, truncated };
}

async function readLimited(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (res.body === null) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function htmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] === undefined ? "" : decode(match[1]).replace(/\s+/g, " ").trim();
  return title === "" ? undefined : title;
}

/** Drops scripts and styles, turns block tags into line breaks, removes the rest of the tags. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|title|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*(br|hr)\b[^>]*>/gi, "\n")
    .replace(
      /<\/?\s*(p|div|section|article|header|footer|main|nav|aside|ul|ol|li|table|tr|h[1-6]|pre|blockquote|form)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<\/\s*(td|th)\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  return decode(stripped)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** File name for a link: `link-1-example-com-spec.md`. */
export function linkFileName(index: number, url: string): string {
  let slug = url;
  try {
    const u = new URL(url);
    slug = `${u.hostname}${u.pathname}`;
  } catch {
    // Keep the raw text.
  }
  slug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return `link-${index}${slug === "" ? "" : `-${slug}`}.md`;
}

/**
 * Fetches every link once, in parallel, and stores each as markdown under `dir`.
 * A link that fails is kept as an attachment with `error` set: it never fails the task.
 */
export async function fetchLinks(
  urls: readonly string[],
  dir: string,
  options: LinkOptions = {},
): Promise<Attachment[]> {
  if (urls.length === 0) return [];
  await mkdir(dir, { recursive: true });
  return Promise.all(
    urls.map(async (url, i): Promise<Attachment> => {
      const id = `link-${i + 1}`;
      try {
        const page = await fetchLink(url, options);
        const path = linkFileName(i + 1, url);
        await writeFile(join(dir, path), page.markdown);
        return {
          id,
          kind: "link",
          name: page.title,
          url,
          path,
          mime: "text/markdown",
          size: Buffer.byteLength(page.markdown),
        };
      } catch (err) {
        const message =
          err instanceof Error && err.name === "TimeoutError"
            ? "The page took more than 10 seconds to answer"
            : errorMessage(err);
        return { id, kind: "link", name: url, url, error: message };
      }
    }),
  );
}

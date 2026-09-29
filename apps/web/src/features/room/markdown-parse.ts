/** A small markdown subset for agent text: no HTML, no images, no nesting beyond quotes. */

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "image"; alt: string; src: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] };

export type Block =
  | { t: "p"; children: Inline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { t: "code"; lang: string; text: string }
  | { t: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { t: "quote"; children: Block[] }
  | { t: "hr" };

const WEB_HREF = /^(https?:\/\/|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isWebHref(href: string): boolean {
  return WEB_HREF.test(href);
}

/**
 * A target the room can use: a web or mail link, or a path to a file in the task folder (relative,
 * or absolute under the folder). Anything else (javascript:, data:, other schemes, `//host`) is
 * dropped and the text stays plain.
 */
export function safeHref(href: string): string | undefined {
  if (WEB_HREF.test(href)) return href;
  if (HAS_SCHEME.test(href) && !/^file:\/\//i.test(href)) return undefined;
  if (href.startsWith("//") || href.startsWith("#") || href === "") return undefined;
  return href;
}

/**
 * The path of a file inside the task folder, relative to it, or undefined when the target is not
 * one: a web link, a path outside the folder, or one that climbs with `..`.
 */
export function taskPathOf(target: string, folder: string | undefined): string | undefined {
  if (WEB_HREF.test(target)) return undefined;
  let path = target.replace(/^file:\/\//i, "").split(/[?#]/)[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (path.startsWith("/")) {
    const root = folder?.replace(/\/+$/, "");
    if (root === undefined || root === "" || !path.startsWith(`${root}/`)) return undefined;
    path = path.slice(root.length + 1);
  }
  const segments = path.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.length === 0 || segments.includes("..")) return undefined;
  return segments.join("/");
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Inline spans. A marker without its closing partner is plain text, so a half-streamed `**bo` reads sensibly. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text !== "") out.push({ t: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2 && src[i + 2] !== " ") {
        flush();
        out.push({ t: "strong", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    } else if (c === "*" || c === "_") {
      const end = closingEmphasis(src, i, c);
      if (end !== -1) {
        flush();
        out.push({ t: "em", children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    } else if (c === "!" && src[i + 1] === "[") {
      const m = /^!\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(src.slice(i));
      const target = m ? safeHref(m[2] as string) : undefined;
      if (m && target) {
        flush();
        out.push({ t: "image", alt: m[1] as string, src: target });
        i += m[0].length;
        continue;
      }
    } else if (c === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        const label = parseInline(m[1] as string);
        const href = safeHref(m[2] as string);
        if (href) out.push({ t: "link", href, children: label });
        else out.push(...label);
        i += m[0].length;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return out;
}

function closingEmphasis(src: string, open: number, mark: "*" | "_"): number {
  if (src[open + 1] === undefined || /\s/.test(src[open + 1] as string) || src[open + 1] === mark) return -1;
  // snake_case and 2*3 are not emphasis.
  if (isWordChar(src[open - 1])) return -1;
  let end = open + 1;
  for (;;) {
    end = src.indexOf(mark, end + 1);
    if (end === -1) return -1;
    if (/\s/.test(src[end - 1] as string)) continue;
    if (mark === "_" && isWordChar(src[end + 1])) continue;
    return end;
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

/** Blocks from text that may still be streaming: an unclosed fence is a code block to the end. */
export function parseMarkdown(src: string): Block[] {
  return parseLines(src.replace(/\r\n?/g, "\n").split("\n"));
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length > 0) blocks.push({ t: "p", children: parseInline(para.join("\n")) });
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = FENCE.exec(line);
    if (fence) {
      endPara();
      const mark = (fence[1] as string)[0] as string;
      const size = (fence[1] as string).length;
      const body: string[] = [];
      i += 1;
      const closing = new RegExp(`^ {0,3}${mark === "`" ? "`" : "~"}{${size},}\\s*$`);
      while (i < lines.length && !closing.test(lines[i] as string)) {
        body.push(lines[i] as string);
        i += 1;
      }
      i += 1; // the closing fence, if there was one
      blocks.push({ t: "code", lang: fence[2] as string, text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      endPara();
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endPara();
      blocks.push({
        t: "h",
        level: (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] as string),
      });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      endPara();
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      endPara();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        inner.push((QUOTE.exec(lines[i] as string) as RegExpExecArray)[1] as string);
        i += 1;
      }
      blocks.push({ t: "quote", children: parseLines(inner) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      endPara();
      const isOrdered = ordered !== null;
      const start = ordered ? Number(ordered[1]) : 1;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const cur = lines[i] as string;
        const m = isOrdered ? ORDERED.exec(cur) : BULLET.exec(cur);
        if (m) {
          items.push(parseInline((isOrdered ? m[2] : m[1]) as string));
          i += 1;
        } else if (/^\s{2,}\S/.test(cur) && items.length > 0 && !FENCE.test(cur)) {
          // A wrapped line of the item above.
          (items[items.length - 1] as Inline[]).push(...parseInline(`\n${cur.trim()}`));
          i += 1;
        } else break;
      }
      blocks.push({ t: "list", ordered: isOrdered, start, items });
      continue;
    }
    para.push(line);
    i += 1;
  }
  endPara();
  return blocks;
}

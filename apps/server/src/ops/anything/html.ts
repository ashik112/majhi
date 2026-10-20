import { createHash } from "node:crypto";

/**
 * A small, forgiving HTML reader for the price and page watches. A page is data: this reads what is at
 * a selector or in the main text and nothing else. It runs no script, loads no resource and follows no
 * link. Only what the owner asked for (a value, a hash of the main text) is kept.
 */

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  /** Text directly inside, in order with the children kept apart: `text` is the node's own text parts joined. */
  text: string;
  parent?: HtmlNode | undefined;
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const SKIP_TEXT = new Set(["script", "style", "noscript", "svg", "template", "head"]);
const BOILERPLATE = new Set(["nav", "header", "footer", "aside", "form", "button", "select", "iframe"]);
const MAX_NODES = 40_000;

function decode(text: string): string {
  return text
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, n: string) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n: string) => {
      const code = Number.parseInt(n, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    });
}

function readAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const name = (m[1] ?? "").toLowerCase();
    if (name !== "") attrs[name] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Parses leniently: unclosed tags close at their parent's end, and a stray close tag is ignored. */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  let cur = root;
  let count = 0;
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|<[!?][^>]*>/g;
  let last = 0;
  const addText = (raw: string) => {
    if (raw !== "") cur.text += `${decode(raw)} `;
  };
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    addText(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] === undefined) continue;
    const tag = m[2].toLowerCase();
    if (m[1] === "/") {
      let up: HtmlNode | undefined = cur;
      while (up !== undefined && up.tag !== tag && up !== root) up = up.parent;
      if (up !== undefined && up !== root) cur = up.parent ?? root;
      continue;
    }
    count += 1;
    if (count > MAX_NODES) break;
    const attrsRaw = m[3] ?? "";
    const node: HtmlNode = { tag, attrs: readAttrs(attrsRaw), children: [], text: "", parent: cur };
    cur.children.push(node);
    if (RAW.has(tag) && !attrsRaw.endsWith("/")) {
      const close = html.toLowerCase().indexOf(`</${tag}`, last);
      const end = close === -1 ? html.length : close;
      node.text = html.slice(last, end);
      const gt = html.indexOf(">", end);
      last = re.lastIndex = gt === -1 ? html.length : gt + 1;
      continue;
    }
    if (!VOID.has(tag) && !attrsRaw.trimEnd().endsWith("/")) cur = node;
  }
  addText(html.slice(last));
  return root;
}

function walk(node: HtmlNode, visit: (n: HtmlNode) => boolean | undefined): void {
  for (const child of node.children) {
    if (visit(child) === true) return;
    walk(child, visit);
  }
}

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; op: "" | "=" | "*=" | "^=" | "$="; value: string }[];
}

function compoundOf(part: string): Compound | undefined {
  const out: Compound = { classes: [], attrs: [] };
  let rest = part;
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*|^\*/.exec(rest);
  if (tag !== null) {
    if (tag[0] !== "*") out.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest !== "") {
    const id = /^#([\w-]+)/.exec(rest);
    const cls = /^\.([\w-]+)/.exec(rest);
    const attr = /^\[\s*([\w:-]+)\s*(?:([*^$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/.exec(rest);
    if (id !== null) {
      out.id = id[1] ?? "";
      rest = rest.slice(id[0].length);
    } else if (cls !== null) {
      out.classes.push(cls[1] ?? "");
      rest = rest.slice(cls[0].length);
    } else if (attr !== null) {
      out.attrs.push({
        name: (attr[1] ?? "").toLowerCase(),
        op: (attr[2] ?? "") as "" | "=" | "*=" | "^=" | "$=",
        value: attr[3] ?? attr[4] ?? attr[5] ?? "",
      });
      rest = rest.slice(attr[0].length);
    } else return undefined;
  }
  return out;
}

function matches(node: HtmlNode, c: Compound): boolean {
  if (c.tag !== undefined && node.tag !== c.tag) return false;
  if (c.id !== undefined && node.attrs.id !== c.id) return false;
  if (c.classes.length > 0) {
    const have = new Set((node.attrs.class ?? "").split(/\s+/));
    if (!c.classes.every((x) => have.has(x))) return false;
  }
  for (const a of c.attrs) {
    const v = node.attrs[a.name];
    if (v === undefined) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
  }
  return true;
}

/** The first element a selector names: tags, ids, classes, attributes and the descendant space. Undefined for none. */
export function selectFirst(root: HtmlNode, selector: string): HtmlNode | undefined {
  const parts = selector.trim().split(/\s+/).map(compoundOf);
  if (parts.length === 0 || parts.some((p) => p === undefined)) return undefined;
  const chain = parts as Compound[];
  let found: HtmlNode | undefined;
  walk(root, (node) => {
    const last = chain[chain.length - 1];
    if (last === undefined || !matches(node, last)) return undefined;
    let i = chain.length - 2;
    let up = node.parent;
    while (i >= 0 && up !== undefined) {
      const want = chain[i];
      if (want !== undefined && matches(up, want)) i -= 1;
      up = up.parent;
    }
    if (i < 0) {
      found = node;
      return true;
    }
    return undefined;
  });
  return found;
}

/** The text of an element: a meta tag's content, an input's value, else everything inside, spaces collapsed. */
export function textOf(node: HtmlNode): string {
  if (node.tag === "meta") return node.attrs.content ?? "";
  if (node.tag === "input") return node.attrs.value ?? "";
  const parts: string[] = [];
  const add = (n: HtmlNode) => {
    if (SKIP_TEXT.has(n.tag)) return;
    parts.push(n.text);
    for (const c of n.children) add(c);
  };
  add(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** The page's main text: the main or article element, else the body, without navigation and scripts. */
export function mainText(root: HtmlNode, limit = 20_000): string {
  const main = selectFirst(root, "main") ?? selectFirst(root, "article") ?? selectFirst(root, "body") ?? root;
  const parts: string[] = [];
  const add = (n: HtmlNode) => {
    if (SKIP_TEXT.has(n.tag) || BOILERPLATE.has(n.tag)) return;
    parts.push(n.text);
    for (const c of n.children) add(c);
  };
  add(main);
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The contents of `script type="application/ld+json"` blocks, for a price the page declares about itself. */
export function jsonLd(root: HtmlNode): string[] {
  const out: string[] = [];
  walk(root, (n) => {
    if (n.tag === "script" && (n.attrs.type ?? "").toLowerCase() === "application/ld+json") out.push(n.text);
    return undefined;
  });
  return out;
}

/** A price in a string: "$1,799.00", "1.799,00 €", "USD 49". Undefined when there is no number. */
export function parsePrice(text: string): { value: number; symbol: string } | undefined {
  const m = /([$€£¥₹]|USD|EUR|GBP|BDT|INR|Tk\.?)?\s*(\d[\d.,\s]*\d|\d)/i.exec(text);
  if (m === null) return undefined;
  const symbol = (m[1] ?? "").replace(/^Tk\.?$/i, "Tk ");
  let digits = (m[2] ?? "").replace(/\s/g, "");
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    // Whichever comes last is the decimal mark.
    digits = lastComma > lastDot ? digits.replace(/\./g, "").replace(",", ".") : digits.replace(/,/g, "");
  } else if (lastComma !== -1) {
    digits = /,\d{2}$/.test(digits) ? digits.replace(",", ".") : digits.replace(/,/g, "");
  } else if (lastDot !== -1 && /\.\d{3}(?!\d)/.test(digits) && digits.split(".").length > 2) {
    digits = digits.replace(/\./g, "");
  }
  const value = Number(digits);
  return Number.isFinite(value) ? { value, symbol } : undefined;
}

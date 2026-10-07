import { type Block, type Body, type Inline, splitMentions } from "@majhi/shared";
import type { PhrasingContent, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * What majhi writes to a client chat, in one neutral body (`Body` in @majhi/shared) that each chat app renders in its
 * own markup. The captain writes a small Markdown subset (paragraphs, **bold**, _italic_, `code`, code blocks,
 * links, lists) and `@[contact:<id>]` to mention a person. It is parsed once, here, with the Markdown parser the rest of
 * majhi uses; nothing below looks at text with patterns.
 */

const markdown = unified().use(remarkParse);

const text = (value: string): Inline => ({ t: "text", text: value });

/** Text with its mention tokens made into mention nodes. */
function withMentions(value: string): Inline[] {
  return splitMentions(value).map((p) =>
    "mention" in p ? { t: "mention", contact: p.mention } : text(p.text),
  );
}

function inlines(nodes: readonly PhrasingContent[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push(...withMentions(node.value));
        break;
      case "strong":
        out.push({ t: "bold", children: inlines(node.children) });
        break;
      case "emphasis":
        out.push({ t: "italic", children: inlines(node.children) });
        break;
      case "delete":
        out.push(...inlines(node.children));
        break;
      case "inlineCode":
        out.push({ t: "code", text: node.value });
        break;
      case "link":
        out.push({ t: "link", href: node.url, children: inlines(node.children) });
        break;
      case "image":
        out.push({
          t: "link",
          href: node.url,
          children: [
            text(node.alt === null || node.alt === undefined || node.alt === "" ? node.url : node.alt),
          ],
        });
        break;
      case "break":
        out.push(text("\n"));
        break;
      case "html":
        // Raw markup is words here, never markup.
        out.push(text(node.value));
        break;
      default:
        // References and footnotes need definitions chat apps do not have: their words stay.
        if ("children" in node) out.push(...inlines(node.children as PhrasingContent[]));
        else if ("value" in node) out.push(text(String(node.value)));
    }
  }
  return out;
}

function blocks(nodes: readonly RootContent[]): Block[] {
  const out: Block[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        out.push({ t: "paragraph", children: inlines(node.children) });
        break;
      case "heading":
        out.push({ t: "paragraph", children: [{ t: "bold", children: inlines(node.children) }] });
        break;
      case "code":
        out.push({
          t: "codeBlock",
          text: node.value,
          ...(node.lang == null || node.lang === "" ? {} : { lang: node.lang }),
        });
        break;
      case "blockquote":
        out.push(...blocks(node.children));
        break;
      case "list": {
        const items: Inline[][] = [];
        for (const item of node.children) {
          const inner = blocks(item.children);
          const line: Inline[] = [];
          for (const block of inner) {
            if (block.t === "list") {
              // A nested list is more items of the same list.
              items.push(line.splice(0));
              items.push(...block.items);
              continue;
            }
            if (line.length > 0) line.push(text("\n"));
            line.push(
              ...(block.t === "paragraph" ? block.children : [{ t: "code", text: block.text } as Inline]),
            );
          }
          if (line.length > 0) items.push(line);
        }
        out.push({ t: "list", ordered: node.ordered === true, items: items.filter((i) => i.length > 0) });
        break;
      }
      case "thematicBreak":
      case "definition":
      case "yaml":
        break;
      case "html":
        out.push({ t: "paragraph", children: [text(node.value)] });
        break;
      default:
        if ("children" in node) out.push(...blocks(node.children as RootContent[]));
        else if ("value" in node) out.push({ t: "paragraph", children: [text(String(node.value))] });
    }
  }
  return out;
}

/** Parses the captain's text into the neutral body. Plain text with no markup is one paragraph per blank-line block. */
export function parseBody(source: string): Body {
  return blocks(markdown.parse(source).children);
}

// ---------------------------------------------------------------------------
// Rendering

/** Who a mention names, as one chat app knows them. Absent fields mean the app gave none. */
export interface Person {
  name: string;
  /** The app's own user id. */
  native?: string | undefined;
  /** The handle the app shows (without the @). */
  username?: string | undefined;
}

/** The people of the chat app a body is rendered for, by contact id. A contact the lookup does not know is left as words. */
export type People = (contact: string) => Person | undefined;

/** How one chat app writes each part. Every function gets text already escaped for the app, except `code`. */
interface Markup {
  escape: (raw: string) => string;
  bold: (inner: string) => string;
  italic: (inner: string) => string;
  code: (raw: string) => string;
  codeBlock: (raw: string, lang: string | undefined) => string;
  link: (href: string, inner: string) => string;
  mention: (person: Person | undefined, contact: string) => string;
}

/** Links that mean something in a chat: web and mail. Anything else keeps its words only. */
function openable(href: string): boolean {
  const lower = href.trim().toLowerCase();
  return lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:");
}

function inline(nodes: readonly Inline[], markup: Markup, people: People): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case "text":
          return markup.escape(node.text);
        case "bold":
          return markup.bold(inline(node.children, markup, people));
        case "italic":
          return markup.italic(inline(node.children, markup, people));
        case "code":
          return markup.code(node.text);
        case "link": {
          const label = inline(node.children, markup, people);
          return openable(node.href)
            ? markup.link(node.href.trim(), label === "" ? markup.escape(node.href) : label)
            : label;
        }
        default:
          return markup.mention(people(node.contact), node.contact);
      }
    })
    .join("");
}

function render(body: Body, markup: Markup, people: People): string {
  return body
    .map((block) => {
      switch (block.t) {
        case "paragraph":
          return inline(block.children, markup, people);
        case "codeBlock":
          return markup.codeBlock(block.text, block.lang);
        default:
          return block.items
            .map((item, i) => `${block.ordered ? `${i + 1}.` : "•"} ${inline(item, markup, people)}`)
            .join("\n");
      }
    })
    .join("\n\n");
}

/** The three characters chat markup reads: the same escape serves Telegram's HTML and Slack. */
function escapeMarkup(raw: string): string {
  return raw.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
}

const TELEGRAM: Markup = {
  escape: escapeMarkup,
  bold: (s) => `<b>${s}</b>`,
  italic: (s) => `<i>${s}</i>`,
  code: (raw) => `<code>${escapeMarkup(raw)}</code>`,
  codeBlock: (raw, lang) =>
    lang === undefined
      ? `<pre>${escapeMarkup(raw)}</pre>`
      : `<pre><code class="language-${escapeMarkup(lang).split('"').join("&quot;")}">${escapeMarkup(raw)}</code></pre>`,
  link: (href, inner) => `<a href="${escapeMarkup(href).split('"').join("&quot;")}">${inner}</a>`,
  mention: (person, contact) => {
    if (person === undefined) return escapeMarkup(contact);
    if (person.username !== undefined && person.username !== "") return `@${escapeMarkup(person.username)}`;
    if (person.native !== undefined)
      return `<a href="tg://user?id=${escapeMarkup(person.native)}">${escapeMarkup(person.name)}</a>`;
    return escapeMarkup(person.name);
  },
};

const SLACK: Markup = {
  escape: escapeMarkup,
  bold: (s) => `*${s}*`,
  italic: (s) => `_${s}_`,
  code: (raw) => `\`${escapeMarkup(raw)}\``,
  codeBlock: (raw) => `\`\`\`\n${escapeMarkup(raw)}\n\`\`\``,
  link: (href, inner) => `<${escapeMarkup(href).split("|").join("%7C")}|${inner}>`,
  mention: (person, contact) => {
    if (person === undefined) return escapeMarkup(contact);
    if (person.native !== undefined) return `<@${person.native}>`;
    return escapeMarkup(person.name);
  },
};

const PLAIN: Markup = {
  escape: (raw) => raw,
  bold: (s) => s,
  italic: (s) => s,
  code: (raw) => raw,
  codeBlock: (raw) => raw,
  link: (href, inner) => (inner === href ? href : `${inner} (${href})`),
  mention: (person, contact) => (person === undefined ? contact : `@${person.name}`),
};

/** Telegram's HTML parse mode. */
export function renderTelegramHtml(body: Body, people: People): string {
  return render(body, TELEGRAM, people);
}

/** Slack's mrkdwn, with `<@U..>` for a person Slack knows. */
export function renderSlack(body: Body, people: People): string {
  return render(body, SLACK, people);
}

/** Words only, names kept: what a reader without markup sees, and what the secret scan and the rails read. */
export function renderPlain(body: Body, people: People): string {
  return render(body, PLAIN, people);
}

// ---------------------------------------------------------------------------
// Long bodies

/** Splits a text into parts of at most `max` characters, at a paragraph, line or space where one is near the end. */
export function splitText(value: string, max: number): string[] {
  const parts: string[] = [];
  let rest = value;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < max / 2) cut = max;
    // Never cut a surrogate pair in two.
    const before = rest.charCodeAt(cut - 1);
    if (before >= 0xd800 && before <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "" || parts.length === 0) parts.push(rest);
  return parts.filter((p) => p !== "");
}

/**
 * Cuts a body into messages that each render within `max` characters, between blocks so no tag is cut open. A block
 * longer than that on its own is sent as plain words, split like text.
 */
export function packBody(
  body: Body,
  max: number,
  rendered: (part: Body) => string,
  plain: (part: Body) => string,
): Body[] {
  const parts: Body[] = [];
  let current: Body = [];
  for (const block of body) {
    if (rendered([block]).length > max) {
      if (current.length > 0) parts.push(current);
      current = [];
      for (const piece of splitText(plain([block]), max)) {
        parts.push([{ t: "paragraph", children: [text(piece)] }]);
      }
      continue;
    }
    if (current.length > 0 && rendered([...current, block]).length > max) {
      parts.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  type IRunOptions,
  LevelFormat,
  Packer,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { Element, ElementContent, RootContent } from "hast";
import { imageSize } from "./image-size.ts";
import { type RenderedDocument, textOf } from "./render.ts";
import { codeColor, FONT_MONO, FONT_SANS, INK } from "./theme.ts";

type Node = RootContent | ElementContent;
type Block = Paragraph | Table;

/** How the text being walked looks: set by the elements around it. */
interface Look {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  superScript?: boolean;
  color?: string;
}

/** A piece of a list item: its text, a nested list, or another block (a code block, a quote, a table). */
type ItemPart =
  | { type: "text"; nodes: Node[] }
  | { type: "list"; node: Element }
  | { type: "block"; node: Element };

/** Where a block is: inside how many quotes, and which list item level. */
interface Place {
  quote: number;
  /** Extra left indent in twips, for paragraphs that continue a list item. */
  indent: number;
}

const hex = (color: string) => color.replace("#", "");
const HEADINGS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
};
const INLINE = new Set([
  "a",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "code",
  "sup",
  "sub",
  "span",
  "br",
  "img",
  "input",
]);
/** The widest an image may be, in pixels: the text width of an A4 page with the margins below. */
const IMAGE_MAX_WIDTH = 640;
const IMAGE_TYPES: Record<string, "png" | "jpg" | "gif" | "bmp"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
};
const LINE = { style: BorderStyle.SINGLE, size: 4, color: hex(INK.line) };
const classesOf = (node: Element): string[] => {
  const c = node.properties.className;
  return Array.isArray(c) ? c.map(String) : [];
};

/**
 * The rendered document as a Word file. It walks the same HTML tree the html and pdf exports print,
 * mapping each element to its Word counterpart: real heading styles (so Word's navigation works),
 * numbered and bulleted lists, tables, code blocks with the viewer's colours, inlined images.
 */
export async function documentDocx(doc: RenderedDocument): Promise<Buffer> {
  const writer = new Writer();
  const children = writer.blocks(doc.tree.children, { quote: 0, indent: 0 });
  const heading = (size: number, color: string = INK.text) => ({
    run: { font: FONT_SANS, size, bold: true, color: hex(color) },
    paragraph: { spacing: { before: 280, after: 120 }, keepNext: true },
  });
  const document = new Document({
    title: doc.title,
    creator: "majhi",
    styles: {
      default: {
        document: {
          run: { font: FONT_SANS, size: 21, color: hex(INK.soft) },
          paragraph: { spacing: { after: 140, line: 300 } },
        },
        heading1: heading(34),
        heading2: heading(28),
        heading3: heading(24),
        heading4: heading(21),
        heading5: heading(21),
        heading6: heading(21, INK.muted),
        hyperlink: { run: { color: hex(INK.link), underline: {} } },
      },
    },
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          // A4 with the margins of the PDF's @page rule.
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1020, bottom: 1020, left: 907, right: 907 },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

class Writer {
  /** Each `<ol>` restarts at 1: a new numbering instance per list. */
  private lists = 0;

  blocks(nodes: readonly Node[], place: Place): Block[] {
    const out: Block[] = [];
    let loose: Node[] = [];
    const flush = () => {
      const runs = this.inlines(loose, {});
      if (runs.length > 0 && loose.some((n) => n.type !== "text" || n.value.trim() !== "")) {
        out.push(this.paragraph(runs, place));
      }
      loose = [];
    };
    for (const node of nodes) {
      if (node.type === "text" || (node.type === "element" && INLINE.has(node.tagName))) {
        loose.push(node);
        continue;
      }
      flush();
      if (node.type === "element") out.push(...this.block(node, place));
    }
    flush();
    return out;
  }

  private block(node: Element, place: Place): Block[] {
    const heading = HEADINGS[node.tagName];
    if (heading !== undefined) {
      return [new Paragraph({ heading, children: this.inlines(node.children, {}) })];
    }
    switch (node.tagName) {
      case "p":
        return [this.paragraph(this.inlines(node.children, {}), place)];
      case "ul":
      case "ol":
        return this.list(node, place, 0);
      case "pre":
        return this.code(node, place);
      case "blockquote":
        return this.blocks(node.children, { ...place, quote: place.quote + 1 });
      case "table":
        return [this.table(node)];
      case "hr":
        return [new Paragraph({ border: { bottom: LINE }, spacing: { after: 240 } })];
      default:
        // div, section (footnotes) and anything else: their content, in place.
        return this.blocks(node.children, place);
    }
  }

  private paragraph(children: ParagraphChild[], place: Place): Paragraph {
    if (place.quote === 0) {
      return new Paragraph({ children, ...(place.indent > 0 ? { indent: { left: place.indent } } : {}) });
    }
    return new Paragraph({
      children,
      indent: { left: place.indent + 280 * place.quote },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: hex(INK.line), space: 8 } },
    });
  }

  private list(node: Element, place: Place, level: number): Block[] {
    const ordered = node.tagName === "ol";
    const instance = ordered ? ++this.lists : 0;
    const out: Block[] = [];
    for (const item of node.children) {
      if (item.type !== "element" || item.tagName !== "li") continue;
      let first = true;
      // The item's own text, then its paragraphs and nested lists in order.
      const parts = this.splitItem(item.children);
      for (const part of parts) {
        if (part.type === "list") {
          out.push(...this.list(part.node, place, Math.min(level + 1, 8)));
          continue;
        }
        if (part.type === "block") {
          out.push(...this.blocks([part.node], { ...place, indent: 360 * (level + 1) }));
          continue;
        }
        const runs = this.inlines(part.nodes, {});
        if (first) {
          out.push(
            new Paragraph({
              children: runs,
              spacing: { after: 60 },
              ...(ordered ? { numbering: { reference: "ordered", level, instance } } : { bullet: { level } }),
              ...(place.quote > 0 ? { indent: { left: 360 * (level + 1) + 280 * place.quote } } : {}),
            }),
          );
          first = false;
        } else {
          out.push(...this.blocks(part.nodes, { ...place, indent: 360 * (level + 1) }));
        }
      }
    }
    return out;
  }

  /** A list item's content in order: runs of inline content or paragraphs, and nested lists. */
  private splitItem(nodes: readonly Node[]): ItemPart[] {
    const parts: ItemPart[] = [];
    let current: Node[] = [];
    const flush = () => {
      if (current.some((n) => n.type !== "text" || n.value.trim() !== ""))
        parts.push({ type: "text", nodes: current });
      current = [];
    };
    for (const node of nodes) {
      if (node.type === "element" && (node.tagName === "ul" || node.tagName === "ol")) {
        flush();
        parts.push({ type: "list", node });
      } else if (node.type === "element" && node.tagName === "p") {
        flush();
        current = [...node.children];
        flush();
      } else if (node.type === "element" && !INLINE.has(node.tagName)) {
        flush();
        parts.push({ type: "block", node });
      } else {
        current.push(node);
      }
    }
    flush();
    return parts;
  }

  /** A code block: one shaded paragraph per line, in the mono font, tokens in the viewer's colours. */
  private code(node: Element, place: Place): Paragraph[] {
    const lines: TextRun[][] = [[]];
    const walk = (nodes: readonly Node[], color: string | undefined) => {
      for (const n of nodes) {
        if (n.type === "text") {
          n.value.split("\n").forEach((piece, i) => {
            if (i > 0) lines.push([]);
            if (piece !== "")
              lines[lines.length - 1]?.push(this.run(piece, { code: true, ...(color ? { color } : {}) }));
          });
        } else if (n.type === "element") {
          walk(n.children, codeColor(classesOf(n)) ?? color);
        }
      }
    };
    walk(node.children, undefined);
    if (lines.length > 1 && lines[lines.length - 1]?.length === 0) lines.pop();
    return lines.map(
      (runs, i) =>
        new Paragraph({
          children: runs,
          shading: { type: ShadingType.CLEAR, fill: hex(INK.wash), color: "auto" },
          spacing: { before: i === 0 ? 60 : 0, after: i === lines.length - 1 ? 200 : 0, line: 260 },
          indent: { left: place.indent + 280 * place.quote + 120, right: 120 },
        }),
    );
  }

  private table(node: Element): Table {
    const rows: TableRow[] = [];
    const walk = (nodes: readonly Node[]) => {
      for (const n of nodes) {
        if (n.type !== "element") continue;
        if (n.tagName !== "tr") {
          walk(n.children);
          continue;
        }
        const header = n.children.some((c) => c.type === "element" && c.tagName === "th");
        const cells = n.children.flatMap((c) => {
          if (c.type !== "element" || (c.tagName !== "td" && c.tagName !== "th")) return [];
          const th = c.tagName === "th";
          const align = c.properties.align;
          return [
            new TableCell({
              children: [
                new Paragraph({
                  children: this.inlines(c.children, th ? { bold: true, color: INK.text } : {}),
                  spacing: { after: 0 },
                  ...(align === "center"
                    ? { alignment: AlignmentType.CENTER }
                    : align === "right"
                      ? { alignment: AlignmentType.RIGHT }
                      : {}),
                }),
              ],
              margins: { top: 60, bottom: 60, left: 120, right: 120 },
              ...(th ? { shading: { type: ShadingType.CLEAR, fill: hex(INK.wash), color: "auto" } } : {}),
            }),
          ];
        });
        if (cells.length > 0) rows.push(new TableRow({ children: cells, tableHeader: header }));
      }
    };
    walk(node.children);
    return new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: LINE,
        bottom: LINE,
        left: LINE,
        right: LINE,
        insideHorizontal: LINE,
        insideVertical: LINE,
      },
    });
  }

  inlines(nodes: readonly Node[], look: Look): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    for (const node of nodes) {
      if (node.type === "text") {
        // A soft line break in markdown is a space on the page.
        const text = look.code ? node.value : node.value.replace(/\s*\n\s*/g, " ");
        if (text !== "") out.push(this.run(text, look));
        continue;
      }
      if (node.type !== "element") continue;
      switch (node.tagName) {
        case "strong":
        case "b":
          out.push(...this.inlines(node.children, { ...look, bold: true }));
          break;
        case "em":
        case "i":
          out.push(...this.inlines(node.children, { ...look, italics: true }));
          break;
        case "del":
        case "s":
          out.push(...this.inlines(node.children, { ...look, strike: true }));
          break;
        case "code":
          out.push(...this.inlines(node.children, { ...look, code: true }));
          break;
        case "sup":
          out.push(...this.inlines(node.children, { ...look, superScript: true }));
          break;
        case "br":
          out.push(new TextRun({ break: 1 }));
          break;
        case "input":
          out.push(this.run(node.properties.checked ? "☑ " : "☐ ", look));
          break;
        case "img":
          out.push(this.image(node));
          break;
        case "a": {
          const href = node.properties.href;
          if (typeof href === "string") {
            const run = new TextRun({ ...this.options(look), text: textOf(node), style: "Hyperlink" });
            out.push(new ExternalHyperlink({ link: href, children: [run] }));
          } else {
            out.push(...this.inlines(node.children, look));
          }
          break;
        }
        default: {
          const color = codeColor(classesOf(node));
          out.push(...this.inlines(node.children, color ? { ...look, color } : look));
        }
      }
    }
    return out;
  }

  private run(text: string, look: Look): TextRun {
    return new TextRun({ ...this.options(look), text });
  }

  private options(look: Look): IRunOptions {
    return {
      ...(look.bold ? { bold: true } : {}),
      ...(look.italics ? { italics: true } : {}),
      ...(look.strike ? { strike: true } : {}),
      ...(look.superScript ? { superScript: true } : {}),
      ...(look.color ? { color: hex(look.color) } : {}),
      ...(look.code
        ? {
            font: FONT_MONO,
            size: 19,
            shading: { type: ShadingType.CLEAR, fill: hex(INK.wash), color: "auto" },
          }
        : {}),
    };
  }

  private image(node: Element): ParagraphChild {
    const src = typeof node.properties.src === "string" ? node.properties.src : "";
    const alt = typeof node.properties.alt === "string" ? node.properties.alt : "";
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(src);
    const type = m?.[1] === undefined ? undefined : IMAGE_TYPES[m[1]];
    const bytes = m?.[2] === undefined ? undefined : Buffer.from(m[2], "base64");
    const size = bytes === undefined ? undefined : imageSize(bytes);
    if (type === undefined || bytes === undefined || size === undefined || size.width === 0) {
      // svg, webp and avif have no Word counterpart here: the alt text stands in.
      return this.run(alt === "" ? "[image]" : `[${alt}]`, { italics: true, color: INK.muted });
    }
    const scale = Math.min(1, IMAGE_MAX_WIDTH / size.width);
    return new ImageRun({
      type,
      data: bytes,
      transformation: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) },
      altText: { name: alt || "image", description: alt, title: alt },
    });
  }
}

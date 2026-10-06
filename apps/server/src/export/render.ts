import { isWebHref, mediaKindOfPath, safeHref } from "@majhi/shared";
import { HIGHLIGHT_OPTIONS, REMARK_PLUGINS } from "@majhi/shared/markdown";
import type { Element, ElementContent, Root, RootContent } from "hast";
import rehypeHighlight from "rehype-highlight";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { IMAGE_LIMIT, IMAGES_TOTAL_LIMIT, type ImageFile, type ImageReader } from "./images.ts";

/** One rendered document: the HTML tree every format is made from, and a title for it. */
export interface RenderedDocument {
  tree: Root;
  title: string;
}

const processor = unified()
  .use(remarkParse)
  .use(REMARK_PLUGINS)
  .use(remarkRehype)
  .use(rehypeHighlight, HIGHLIGHT_OPTIONS);

/**
 * Markdown to the one HTML tree (hast) that html, pdf and docx are all made from. The pipeline is the
 * viewer's (`@majhi/shared/markdown`): raw HTML is dropped, links follow the viewer's rule (web and
 * mail stay links, anything else keeps its text only, as a file link means nothing outside majhi),
 * web images stay links as in the viewer, and images of the task are inlined as data URIs so the
 * document stands alone.
 */
export async function renderDocument(
  markdown: string,
  fallbackTitle: string,
  readImage: ImageReader,
): Promise<RenderedDocument> {
  const tree = (await processor.run(processor.parse(markdown))) as Root;
  const images = new Map<string, Promise<ImageFile | undefined>>();
  collectImages(tree, (src) => {
    if (!images.has(src))
      images.set(
        src,
        readImage(src).catch(() => undefined),
      );
  });
  const loaded = new Map<string, ImageFile>();
  let total = 0;
  for (const [src, pending] of images) {
    const file = await pending;
    if (file === undefined || file.bytes.length > IMAGE_LIMIT) continue;
    if (total + file.bytes.length > IMAGES_TOTAL_LIMIT) continue;
    total += file.bytes.length;
    loaded.set(src, file);
  }
  tree.children = rewrite(tree.children, loaded) as RootContent[];
  return { tree, title: firstHeading(tree) ?? fallbackTitle };
}

/** Image targets that may be files of the task: not web, not other schemes, and of an image type. */
function collectImages(node: Root | Element, add: (src: string) => void): void {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const src = child.tagName === "img" ? child.properties.src : undefined;
    if (typeof src === "string") {
      const safe = safeHref(src);
      if (safe !== undefined && !isWebHref(safe) && mediaKindOfPath(safe) === "image") add(src);
    }
    collectImages(child, add);
  }
}

function rewrite(nodes: readonly (RootContent | ElementContent)[], images: Map<string, ImageFile>) {
  const out: (RootContent | ElementContent)[] = [];
  for (const node of nodes) {
    if (node.type !== "element") {
      out.push(node);
      continue;
    }
    node.children = rewrite(node.children, images) as ElementContent[];
    if (node.tagName === "a") {
      const href = typeof node.properties.href === "string" ? safeHref(node.properties.href) : undefined;
      if (href !== undefined && isWebHref(href)) {
        node.properties = { href };
        out.push(node);
      } else {
        out.push(...node.children);
      }
      continue;
    }
    if (node.tagName === "img") {
      out.push(...image(node, images));
      continue;
    }
    out.push(node);
  }
  return out;
}

function image(node: Element, images: Map<string, ImageFile>): ElementContent[] {
  const src = typeof node.properties.src === "string" ? node.properties.src : "";
  const alt = typeof node.properties.alt === "string" ? node.properties.alt : "";
  const file = images.get(src);
  if (file !== undefined) {
    const properties = { src: `data:${file.type};base64,${file.bytes.toString("base64")}`, alt };
    return [{ type: "element", tagName: "img", properties, children: [] }];
  }
  const safe = safeHref(src);
  if (safe !== undefined && isWebHref(safe)) {
    // As in the viewer: a web image is not loaded, it is a link the reader opens on purpose.
    return [
      {
        type: "element",
        tagName: "a",
        properties: { href: safe },
        children: [{ type: "text", value: alt || safe }],
      },
    ];
  }
  return alt === "" ? [] : [{ type: "text", value: alt }];
}

function firstHeading(tree: Root): string | undefined {
  for (const node of tree.children) {
    if (node.type === "element" && node.tagName === "h1") {
      const text = textOf(node).trim();
      if (text !== "") return text;
    }
  }
  return undefined;
}

export function textOf(node: Root | RootContent | ElementContent): string {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(textOf).join("") : "";
}

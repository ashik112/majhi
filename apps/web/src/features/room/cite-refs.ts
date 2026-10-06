/** Numbered citations in a wiki page's text (`[3]`), which open the source behind the claim. */

export type CitePart = string | { n: number };

/** The hast property that marks a citation in rendered markdown. */
export const CITE_PROP = "dataCite";

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

/** Text split around `[n]` for each `n` in `known`. Brackets with anything else inside stay text. */
export function splitCites(text: string, known: ReadonlySet<number>): CitePart[] {
  if (known.size === 0) return [text];
  const parts: CitePart[] = [];
  let last = 0;
  let at = text.indexOf("[");
  while (at !== -1) {
    let end = at + 1;
    while (isDigit(text[end])) end += 1;
    const n = end > at + 1 && text[end] === "]" ? Number(text.slice(at + 1, end)) : undefined;
    if (n !== undefined && known.has(n)) {
      if (at > last) parts.push(text.slice(last, at));
      parts.push({ n });
      last = end + 1;
    }
    at = text.indexOf("[", at + 1);
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? [text] : parts;
}

// mdast nodes are walked structurally; only these fields are read or written.
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

function walk(node: MdNode, known: ReadonlySet<number>): void {
  if (node.children === undefined || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === "text" && child.value !== undefined) {
      return splitCites(child.value, known).map(
        (part): MdNode =>
          typeof part === "string"
            ? { type: "text", value: part }
            : {
                type: "cite",
                children: [{ type: "text", value: `[${part.n}]` }],
                data: { hName: "span", hProperties: { [CITE_PROP]: String(part.n) } },
              },
      );
    }
    walk(child, known);
    return [child];
  });
}

/** A remark plugin: `[n]` in the text, outside links and code, becomes a citation the page can open. */
export function remarkCites(options: { known: ReadonlySet<number> }) {
  return (tree: MdNode) => {
    if (options.known.size > 0) walk(tree, options.known);
  };
}

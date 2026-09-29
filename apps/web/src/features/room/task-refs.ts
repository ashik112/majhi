/** Task ids in message text (`PRV-15`), which open the task in the drawer. */

// Same shape as TaskIdSchema, not glued to a word, a dash or a dotted number on either side.
const TASK_REF = /(?<![\w-])[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*(?![\w-]|\.\d)/g;

export type TextPart = string | { id: string };

/**
 * Text split around the task ids in it. Only ids in `known` count, so `UTF-8` or `SHA-256` stay
 * text unless a task really has that id.
 */
export function splitTaskRefs(text: string, known: ReadonlySet<string>): TextPart[] {
  if (known.size === 0) return [text];
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(TASK_REF)) {
    const id = match[0];
    if (!known.has(id)) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ id });
    last = match.index + id.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? [text] : parts;
}

/** The hast property that marks a task id in rendered markdown. */
export const TASK_REF_PROP = "dataTaskRef";

// mdast nodes are walked structurally; only these fields are read or written.
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

function refNode(id: string, child: MdNode): MdNode {
  return {
    type: "taskRef",
    children: [child],
    data: { hName: "span", hProperties: { [TASK_REF_PROP]: id } },
  };
}

function walk(node: MdNode, known: ReadonlySet<string>): void {
  if (node.children === undefined || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === "text" && child.value !== undefined) {
      return splitTaskRefs(child.value, known).map((part) =>
        typeof part === "string"
          ? { type: "text", value: part }
          : refNode(part.id, { type: "text", value: part.id }),
      );
    }
    // `PRV-15` in backticks is still a task id; code with anything else in it stays code.
    if (child.type === "inlineCode" && child.value !== undefined && known.has(child.value)) {
      return [refNode(child.value, child)];
    }
    walk(child, known);
    return [child];
  });
}

/** A remark plugin: known task ids in the text, outside links and code blocks, become task refs. */
export function remarkTaskRefs(options: { known: ReadonlySet<string> }) {
  return (tree: MdNode) => {
    if (options.known.size > 0) walk(tree, options.known);
  };
}

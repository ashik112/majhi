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
/** The hast property that marks an agent mention (`@builder`) in rendered markdown. */
export const AGENT_REF_PROP = "dataAgentRef";

// `@id`, not part of an email address or a path, and not followed by more of a word.
const MENTION = /(?<![\w@/.-])@([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])(?![\w@/-])/g;

/** Text split around the mentions of known agents in it (and `@owner`). */
export function splitMentions(text: string, agents: ReadonlySet<string>): (string | { agent: string })[] {
  if (agents.size === 0) return [text];
  const parts: (string | { agent: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const id = match[1] ?? "";
    if (!agents.has(id) && id !== "owner") continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ agent: id });
    last = match.index + match[0].length;
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

function refNode(id: string, child: MdNode): MdNode {
  return {
    type: "taskRef",
    children: [child],
    data: { hName: "span", hProperties: { [TASK_REF_PROP]: id } },
  };
}

function agentNode(id: string): MdNode {
  return {
    type: "agentRef",
    children: [{ type: "text", value: `@${id}` }],
    data: { hName: "span", hProperties: { [AGENT_REF_PROP]: id } },
  };
}

function walk(node: MdNode, known: ReadonlySet<string>, agents: ReadonlySet<string>): void {
  if (node.children === undefined || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === "text" && child.value !== undefined) {
      return splitMentions(child.value, agents).flatMap((piece): MdNode[] =>
        typeof piece !== "string"
          ? [agentNode(piece.agent)]
          : splitTaskRefs(piece, known).map((part) =>
              typeof part === "string"
                ? { type: "text", value: part }
                : refNode(part.id, { type: "text", value: part.id }),
            ),
      );
    }
    // `PRV-15` in backticks is still a task id; code with anything else in it stays code.
    if (child.type === "inlineCode" && child.value !== undefined && known.has(child.value)) {
      return [refNode(child.value, child)];
    }
    walk(child, known, agents);
    return [child];
  });
}

/**
 * A remark plugin: known task ids and agent mentions in the text, outside links and code blocks,
 * become refs that open their drawer.
 */
export function remarkTaskRefs(options: { known: ReadonlySet<string>; agents?: ReadonlySet<string> }) {
  const agents = options.agents ?? new Set<string>();
  return (tree: MdNode) => {
    if (options.known.size > 0 || agents.size > 0) walk(tree, options.known, agents);
  };
}

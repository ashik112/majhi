import { type Agent, type AgentFrontmatter, AgentFrontmatterSchema } from "@majhi/shared";
import { Document, isSeq, parseDocument, visit } from "yaml";
import { formatIssues } from "../errors.ts";

const FENCE = "---";

export type ParsedAgentFile = { ok: true; agent: Agent } | { ok: false; errors: string[] };

/**
 * Reads `---` YAML frontmatter and the markdown body. The file name (without
 * `.md`) must equal the frontmatter `id`. Never throws: problems come back as
 * a list of readable errors.
 */
export function parseAgentFile(fileName: string, text: string): ParsedAgentFile {
  const split = splitFrontmatter(text);
  if (!split.ok) return split;
  const doc = parseDocument(split.yaml);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => `Frontmatter: ${e.message.split("\n", 1)[0] ?? e.message}`),
    };
  }
  const parsed = AgentFrontmatterSchema.safeParse(doc.toJS() ?? {});
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };
  const expected = fileName.replace(/\.md$/, "");
  if (parsed.data.id !== expected) {
    return {
      ok: false,
      errors: [`id: The file is ${fileName}, so the id must be "${expected}", not "${parsed.data.id}"`],
    };
  }
  return { ok: true, agent: { frontmatter: parsed.data, instructions: split.body } };
}

function splitFrontmatter(
  text: string,
): { ok: true; yaml: string; body: string } | { ok: false; errors: string[] } {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== FENCE) {
    return { ok: false, errors: ["The file must start with a --- line and YAML frontmatter"] };
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === FENCE);
  if (end === -1) return { ok: false, errors: ["The frontmatter is not closed with a --- line"] };
  const yaml = lines.slice(1, end).join("\n");
  let body = lines.slice(end + 1).join("\n");
  // One blank line separates the frontmatter from the instructions.
  if (body.startsWith("\n")) body = body.slice(1);
  return { ok: true, yaml, body };
}

/**
 * The file text for an agent. Keys are always in the same order and every
 * field is written, so a hand edit shows up as a small diff in the history.
 */
export function serializeAgent(agent: Agent): string {
  const yaml = stringifyFrontmatter(agent.frontmatter);
  const body = agent.instructions === "" ? "" : `\n${agent.instructions}`;
  return `${FENCE}\n${yaml}${FENCE}\n${body}`;
}

function stringifyFrontmatter(f: AgentFrontmatter): string {
  const ordered: Record<string, unknown> = {
    id: f.id,
    scope: f.scope,
    role: f.role,
    emoji: f.emoji,
    account: f.account,
    model: f.model,
    effort: f.effort,
    tier: f.tier,
    models: f.models,
    where: f.where,
    perms: f.perms,
    tools: f.tools,
    connections: f.connections,
    skills: f.skills,
    fallback: f.fallback,
    context: f.context,
    turns: f.turns,
    origin: f.origin,
  };
  for (const key of Object.keys(ordered)) if (ordered[key] === undefined) delete ordered[key];
  const doc = new Document(ordered);
  visit(doc, {
    Seq(_key, node) {
      if (isSeq(node)) node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

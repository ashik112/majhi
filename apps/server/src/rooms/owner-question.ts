/**
 * Whether an agent's final message asks the owner something, from its words alone. The decision model is
 * not asked: on Laya no wording of this question was reliable. This only decides whether a Reply card is
 * put under the message and whether the step waits; it never wakes an agent.
 */

/** The text an agent wrote itself: no code, no quoted lines. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/**
 * Whether an agent's message asks the owner for something, from its words alone: a question that
 * is not addressed to another agent, or a plain request for a decision. Code and quotes are not
 * read.
 */
export function asksOwner(text: string): boolean {
  return ownerQuestion(text) !== undefined;
}

/**
 * The words that ask the owner something, or undefined. Only the message's last paragraph counts:
 * a status report with a question in the middle ("did the name resolve? It does now.") asks nothing.
 * Questions in parentheses, code and quotes are not read, nor ones addressed to another agent.
 */
export function ownerQuestion(text: string): string | undefined {
  const t = plainText(text).replace(/\([^)]*\)/g, " ");
  if (/(^|\s)@owner\b/i.test(t)) return lastParagraph(t);
  const last = lastParagraph(t);
  if (
    /\b(let me know|please (confirm|decide|approve|advise|choose)|your (call|decision|approval|go-ahead))\b/i.test(
      last,
    )
  )
    return last;
  const questions = (last.match(/[^.!?\n]*\?/g) ?? [])
    .map((q) => q.trim())
    .filter((q) => q !== "" && !/(^|\s)@(?!owner\b)[a-z0-9][a-z0-9-]*/i.test(q));
  return questions.length === 0 ? undefined : questions.join(" ");
}

function lastParagraph(text: string): string {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return (parts.at(-1) ?? "").slice(0, 600);
}

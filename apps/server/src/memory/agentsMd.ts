const HEADING = /^##\s+Facts\s*$/i;

/** A fact as one bullet line. */
export function bullet(fact: string): string {
  return `- ${fact.replace(/\s+/g, " ").trim()}`;
}

/**
 * `markdown` with the fact as a bullet at the end of its `## Facts` section, which is added at the
 * end of the file when there is none. A fact that is already there changes nothing: the result is
 * `markdown` itself. The rest of the file is left as it was.
 */
export function addFact(markdown: string, fact: string): string {
  const line = bullet(fact);
  const lines = markdown === "" ? [] : markdown.replace(/\n$/, "").split("\n");
  if (lines.some((l) => l.trim() === line)) return markdown;
  const at = lines.findIndex((l) => HEADING.test(l.trim()));
  if (at === -1) {
    const head = lines.length === 0 ? ["# AGENTS.md", ""] : [...lines, ""];
    return `${[...head, "## Facts", "", line].join("\n")}\n`;
  }
  // The section runs to the next heading; the bullet goes after its last non-blank line.
  let end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l));
  if (end === -1) end = lines.length;
  let last = end - 1;
  while (last > at && lines[last]?.trim() === "") last -= 1;
  const before = lines.slice(0, last + 1);
  // A heading straight under `## Facts` with no bullet yet gets a blank line first.
  if (last === at) before.push("");
  const out = [...before, line, ...lines.slice(last + 1)];
  return `${out.join("\n")}\n`;
}

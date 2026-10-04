/**
 * Whether the lead's final report answers the brief of a task that changed no code: it has findings
 * and asks nothing back. Plain rules, so the same report always gets the same verdict.
 */

/** A report shorter than this holds no findings. */
const MIN_REPORT_CHARS = 120;

const ASKS_BACK =
  /\b(should i|shall i|do you want|would you like|let me know|which (one|option|approach)|please (confirm|clarify|advise)|i need (your|you to)|need your (input|decision|go-ahead)|waiting (for|on) (you|your)|open questions?:?\s+(?!none\b|no\b|nothing\b)\w+|blocked (on|by))\b/i;

export type AnswerVerdict = { complete: true } | { complete: false; why: string };

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 3)}...`;
}

export function judgeReport(report: string | undefined): AnswerVerdict {
  const text = report?.trim() ?? "";
  if (text.length < MIN_REPORT_CHARS) {
    return {
      complete: false,
      why: "Your final report is empty or too short to hold findings. Write what you found, with the evidence, as your last message.",
    };
  }
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? text;
  if (last.trimEnd().endsWith("?") || ASKS_BACK.test(last)) {
    return {
      complete: false,
      why: `Your report ends with an open question: "${clip(last, 160)}". Settle it from the repo or the brief, or say exactly what blocks you, then finish with the findings.`,
    };
  }
  return { complete: true };
}

/** One line of the report for the log. */
export function summaryLine(report: string): string {
  const first = report
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find((l) => l !== "");
  return clip(first ?? report, 140);
}

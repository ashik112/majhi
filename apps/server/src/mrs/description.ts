/** What an MR description says about the task (SPEC 5.5). Plain text in markdown, no secrets from the room. */

export interface MrSibling {
  project: string;
  /** Absent while that MR is not open yet. */
  url?: string | undefined;
}

export interface DescriptionInput {
  taskId: string;
  title: string;
  brief: string;
  /** The repo this MR is for. */
  project: string;
  /** Every repo of the task that has an MR, in merge order, this one included. */
  siblings: readonly MrSibling[];
}

/** How much of the brief goes to the host: it is a summary, and the host is outside majhi. */
export const SUMMARY_MAX = 600;

/** The brief without its first line (the title), on one paragraph, cut at a word. */
export function briefSummary(title: string, brief: string): string {
  const lines = brief.trim().split("\n");
  const rest = (lines[0]?.trim() === title.trim() ? lines.slice(1) : lines).join(" ");
  const text = rest.replace(/\s+/g, " ").trim();
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX);
  const at = cut.lastIndexOf(" ");
  return `${(at > SUMMARY_MAX / 2 ? cut.slice(0, at) : cut).trimEnd()}...`;
}

/** The MR title: the task id and title, so the host list shows which task a MR belongs to. */
export function mrTitle(taskId: string, title: string): string {
  return `${taskId}: ${title}`.slice(0, 200);
}

export function renderMrDescription(input: DescriptionInput): string {
  const out: string[] = [`Task ${input.taskId}: ${input.title}`];
  const summary = briefSummary(input.title, input.brief);
  if (summary !== "") out.push("", summary);
  if (input.siblings.length > 1) {
    out.push("", "This task changes several repos. Merge requests, in the order they merge:", "");
    input.siblings.forEach((s, i) => {
      const self = s.project === input.project ? " (this MR)" : "";
      out.push(`${i + 1}. ${s.project}${self}: ${s.url ?? "not open yet"}`);
    });
  }
  return `${out.join("\n")}\n`;
}

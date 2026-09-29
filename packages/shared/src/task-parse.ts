import type { ParseContext, ParsedTask } from "./tasks.ts";

/**
 * Reads the task box text (SPEC 3.1): repos by project id or alias, base
 * branch (`from develop`, `base: main`, `off release/2.1`), working branch
 * (`on feature/x`, `branch fix/y`; must contain a slash), `@agent` mentions,
 * links, and warnings (no repo found, repos from more than one org). Pure and
 * fast: it runs on every keystroke.
 */
export function parseTaskText(_text: string, _ctx: ParseContext): ParsedTask {
  throw new Error("not implemented");
}

import type { HandoffCommands } from "@majhi/shared";

/** The commands a hand-off check runs for one project, before `{base}` is filled in. */
export interface CheckCommands {
  test?: string | undefined;
  build?: string | undefined;
  lint?: string | undefined;
  typecheck?: string | undefined;
}

/** The project's own commands win over the ones its card read from the repo, command by command. */
export function effectiveCommands(
  card: CheckCommands | undefined,
  override: HandoffCommands | undefined,
): CheckCommands {
  const out: CheckCommands = { ...card };
  for (const key of ["test", "build", "lint", "typecheck"] as const) {
    const line = override?.[key];
    if (line !== undefined && line.trim() !== "") out[key] = line;
  }
  return out;
}

const BASE_PLACEHOLDER = "{base}";
const FULL_SHA = /^[0-9a-f]{40}$/;

export function usesBase(command: string): boolean {
  return command.includes(BASE_PLACEHOLDER);
}

/**
 * Fills `{base}` with the merge-base commit majhi computed. Only a full 40-character hex sha goes
 * into the shell line: anything else is refused, so no text from a task or a repo reaches the shell.
 */
export function substituteBase(
  command: string,
  base: string | undefined,
): { command: string } | { error: string } {
  if (!usesBase(command)) return { command };
  if (base === undefined || !FULL_SHA.test(base)) {
    return { error: "majhi could not find the commit this task branched from, so {base} was not filled in" };
  }
  return { command: command.split(BASE_PLACEHOLDER).join(base) };
}

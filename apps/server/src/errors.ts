import type { z } from "zod";

/** Turns zod issues into readable lines, `path: message`, one per problem. */
export function formatIssues(error: z.ZodError): string[] {
  const lines: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) lines.push(`${formatPath([...issue.path, key])}: Unknown key`);
      continue;
    }
    const path = formatPath(issue.path);
    lines.push(path === "" ? issue.message : `${path}: ${issue.message}`);
  }
  return lines;
}

/** `["workspaces", 0]` becomes `workspaces[0]`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/** The `code` of a Node system error, like `ENOENT`. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exit status of a failed `execFile`, when the process ran and exited non-zero. */
export function exitCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "number") {
    return err.code;
  }
  return undefined;
}

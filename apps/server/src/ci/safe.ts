import { packageScript } from "./classify.ts";
import { readOnlyArgv } from "./readonly.ts";
import { parseShell, programOf, renderShell, type Segment } from "./shell.ts";

/**
 * A check line in the form that only reads. Commands that write are turned into their read-only form
 * (`readonly.ts`), and a package script that writes (`"lint": "eslint --fix ."`) is run through its tool
 * directly, in the read-only form, because the package manager would run the script as written.
 */

export type SafeLine =
  | {
      ok: true;
      command: string /** What changed, for the owner: "eslint ran without --fix". */;
      notes: string[];
    }
  | { ok: false; why: string };

/** The body of a package.json script in the check's folder, or undefined when there is none. */
export type ScriptLookup = (name: string) => Promise<string | undefined>;

/** Programs a shell runs itself: a script that uses them cannot be run tool by tool. */
const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  "cd",
  "echo",
  "export",
  "set",
  "test",
  "[",
  "true",
  "false",
  "exit",
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "cat",
  "sed",
  "git",
]);

/** How each package manager starts a tool from the project's own `node_modules/.bin`. */
const EXEC: Record<string, string[]> = {
  pnpm: ["pnpm", "exec"],
  npm: ["npm", "exec", "--"],
  yarn: ["yarn", "exec"],
  bun: ["bun", "x"],
};

const MAX_DEPTH = 3;

async function safeSegments(
  segments: readonly Segment[],
  lookup: ScriptLookup,
  depth: number,
  notes: string[],
): Promise<Segment[] | { why: string }> {
  const out: Segment[] = [];
  for (const seg of segments) {
    const script = packageScript(seg.argv);
    if (script !== undefined) {
      const body = await lookup(script.script);
      if (body !== undefined && depth < MAX_DEPTH) {
        const inner = parseShell(body);
        if (inner.ok) {
          const probe = await safeSegments(inner.segments, lookup, depth + 1, []);
          const writes =
            "why" in probe ||
            probe.some((p, i) => renderShell([p]) !== renderShell([inner.segments[i] ?? p])) ||
            probe.length !== inner.segments.length;
          if (writes) {
            if ("why" in probe) return probe;
            const exec = EXEC[script.manager];
            const tools = probe.every((p) => !SHELL_BUILTINS.has(programOf(p.argv)));
            if (exec === undefined || !tools)
              return {
                why: `its script ${script.script} changes files and runs steps majhi cannot make read-only`,
              };
            const extra = seg.argv.slice(seg.argv.indexOf(script.script) + 1).filter((a) => a !== "--");
            notes.push(`the ${script.script} script ran read-only`);
            probe.forEach((p, i) => {
              const last = i === probe.length - 1;
              out.push({
                env: { ...seg.env, ...p.env },
                argv: [...exec, ...p.argv, ...(last ? extra : [])],
                ...(p.joins === undefined
                  ? seg.joins === undefined
                    ? {}
                    : { joins: seg.joins }
                  : { joins: p.joins }),
              });
            });
            continue;
          }
        }
      }
      out.push(seg);
      continue;
    }
    const safe = readOnlyArgv(seg.argv);
    if ("skip" in safe) return { why: safe.skip };
    if (safe.changed) notes.push(`${programOf(seg.argv)} ran read-only`);
    out.push({ ...seg, argv: safe.argv });
  }
  return out;
}

/** The read-only form of a shell line. A line majhi cannot read is returned as it is. */
export async function safeLine(line: string, lookup: ScriptLookup): Promise<SafeLine> {
  const parsed = parseShell(line);
  if (!parsed.ok) return { ok: true, command: line, notes: [] };
  const notes: string[] = [];
  const out = await safeSegments(parsed.segments, lookup, 0, notes);
  if ("why" in out) return { ok: false, why: out.why };
  return { ok: true, command: notes.length === 0 ? line : renderShell(out), notes: [...new Set(notes)] };
}

import { programOf } from "./shell.ts";

/**
 * A check only reads. A lint or format command that rewrites files (`eslint --fix`, `prettier --write`,
 * `gofmt -w`, `ruff --fix`) is turned into its read-only form, which reports the same problems and changes
 * nothing. A command that has no read-only form is skipped, with the reason. Decided from the command's
 * parts: its program, its sub-command and its flags.
 */

export type ReadOnly = { argv: string[]; changed: boolean } | { skip: string };

/** Words in front of the real program: package runners and interpreters. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "npx",
  "pnpx",
  "bunx",
  "pnpm",
  "yarn",
  "npm",
  "bun",
  "exec",
  "dlx",
  "run",
  "uv",
  "uvx",
  "poetry",
  "pipx",
  "python",
  "python3",
  "-m",
  "go",
  "cargo",
  "dotnet",
  "terraform",
  "deno",
  "bundle",
]);

function without(
  args: readonly string[],
  flags: ReadonlySet<string>,
  valued: ReadonlySet<string> = new Set(),
) {
  const out: string[] = [];
  let removed = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    const name = a.includes("=") && a.startsWith("--") ? a.slice(0, a.indexOf("=")) : a;
    if (flags.has(name)) {
      removed = true;
      continue;
    }
    if (valued.has(name)) {
      removed = true;
      if (!a.includes("=")) i++;
      continue;
    }
    out.push(a);
  }
  return { args: out, removed };
}

const has = (args: readonly string[], ...names: string[]): boolean => args.some((a) => names.includes(a));
const done = (before: readonly string[], after: readonly string[]): ReadOnly => ({
  argv: [...after],
  changed: before.length !== after.length || before.some((a, i) => a !== after[i]),
});

type Rule = (args: readonly string[]) => ReadOnly;

const dropFlags =
  (flags: string[], valued: string[] = []): Rule =>
  (args) =>
    done(args, without(args, new Set(flags), new Set(valued)).args);

const addFlagUnless =
  (flag: string, unless: string[]): Rule =>
  (args) =>
    has(args, flag, ...unless) ? done(args, args) : done(args, [...args, flag]);

/** `prettier --write` becomes `--check`. */
const prettier: Rule = (args) => {
  if (!has(args, "--write", "-w")) return done(args, args);
  const rest = without(args, new Set(["--write", "-w"])).args;
  return done(args, has(rest, "--check", "-c") ? rest : [...rest, "--check"]);
};

const biome: Rule = (args) =>
  done(args, without(args, new Set(["--write", "--fix", "--apply", "--apply-unsafe", "--unsafe"])).args);

const gofmt: Rule = (args) =>
  done(
    args,
    args.map((a) => (a === "-w" ? "-l" : a)),
  );

const ruff: Rule = (args) => {
  if (has(args, "--fix-only"))
    return { skip: "ruff --fix-only only rewrites files and has no read-only form" };
  const kept = without(args, new Set(["--fix", "--unsafe-fixes", "--no-unsafe-fixes", "--show-fixes"])).args;
  const sub = kept.find((a) => !a.startsWith("-"));
  return sub === "format" ? addFlagUnless("--check", ["--diff"])(kept) : done(args, kept);
};

const cargo: Rule = (args) => {
  const sub = args.find((a) => !a.startsWith("-") && !a.startsWith("+"));
  if (sub === "fmt") return has(args, "--check") ? done(args, args) : done(args, [...args, "--check"]);
  if (sub === "clippy" || sub === "fix")
    return sub === "fix"
      ? { skip: "cargo fix rewrites files and has no read-only form" }
      : done(
          args,
          without(args, new Set(["--fix", "--allow-dirty", "--allow-staged", "--allow-no-vcs"])).args,
        );
  return done(args, args);
};

const terraform: Rule = (args) => {
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub !== "fmt") return done(args, args);
  return has(args, "-check") ? done(args, args) : done(args, [...args, "-check"]);
};

const dotnet: Rule = (args) => {
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub !== "format") return done(args, args);
  return has(args, "--verify-no-changes") ? done(args, args) : done(args, [...args, "--verify-no-changes"]);
};

const denoFmt: Rule = (args) => {
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub !== "fmt") return done(args, args);
  return has(args, "--check") ? done(args, args) : done(args, [...args, "--check"]);
};

const phpCsFixer: Rule = (args) => {
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub !== "fix") return done(args, args);
  return has(args, "--dry-run") ? done(args, args) : done(args, [...args, "--dry-run"]);
};

/** Tools by the name of their program. */
const RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ["eslint", dropFlags(["--fix", "--fix-type"], ["--fix-type"])],
  ["eslint_d", dropFlags(["--fix", "--fix-type"], ["--fix-type"])],
  ["oxlint", dropFlags(["--fix", "--fix-suggestions", "--fix-dangerously"])],
  ["stylelint", dropFlags(["--fix"])],
  ["golangci-lint", dropFlags(["--fix"])],
  ["standard", dropFlags(["--fix"])],
  ["rubocop", dropFlags(["-a", "-A", "--auto-correct", "--auto-correct-all", "-x", "--fix-layout"])],
  ["prettier", prettier],
  ["biome", biome],
  ["gofmt", gofmt],
  ["goimports", gofmt],
  ["ruff", ruff],
  ["black", addFlagUnless("--check", ["--diff"])],
  ["isort", addFlagUnless("--check-only", ["-c", "--check"])],
  ["rustfmt", addFlagUnless("--check", [])],
  ["cargo", cargo],
  ["terraform", terraform],
  ["tofu", terraform],
  ["dotnet", dotnet],
  ["deno", denoFmt],
  ["php-cs-fixer", phpCsFixer],
  ["yapf", () => ({ skip: "yapf only rewrites files unless asked for a diff" })],
  ["autopep8", () => ({ skip: "autopep8 only rewrites files unless asked for a diff" })],
]);

/** Flags that mean a tool rewrites files in place: an unknown tool with one is skipped. */
const WRITE_FLAGS: ReadonlySet<string> = new Set(["--in-place"]);

/** The read-only form of one command, found after any package runner in front of it (`npx`, `pnpm exec`). */
export function readOnlyArgv(argv: readonly string[]): ReadOnly {
  let at: number | undefined;
  for (let i = 0; i < argv.length && i < 6; i++) {
    const word = argv[i] ?? "";
    if (RULES.has(programOf([word]))) {
      at = i;
      break;
    }
    if (!WRAPPERS.has(programOf([word])) && !word.startsWith("-")) break;
  }
  if (at === undefined) {
    // A program with no rule of its own: only a flag that always means an in-place rewrite is acted on.
    if (argv.some((a) => WRITE_FLAGS.has(a)))
      return { skip: `${programOf(argv)} would rewrite files and has no read-only form` };
    return { argv: [...argv], changed: false };
  }
  const rule = RULES.get(programOf([argv[at] ?? ""]));
  if (rule === undefined) return { argv: [...argv], changed: false };
  const out = rule(argv.slice(at + 1));
  return "skip" in out ? out : { argv: [...argv.slice(0, at + 1), ...out.argv], changed: out.changed };
}

/** True when a command would change files, for the places that only need to know. */
export function writesFiles(argv: readonly string[]): boolean {
  const out = readOnlyArgv(argv);
  return "skip" in out || out.changed;
}

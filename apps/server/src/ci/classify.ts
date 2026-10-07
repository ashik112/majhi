import { programOf } from "./shell.ts";

/**
 * What a command is for, decided from its parts: the program, its sub-command and the words of the
 * script or task it runs. Never from the text of the whole line.
 */

export type CheckKind = "lint" | "typecheck" | "test" | "build";
export type CommandKind = CheckKind | "install";

export const CHECK_KINDS: readonly CheckKind[] = ["lint", "typecheck", "test", "build"];

/** The words of a name like `test:unit` or `check-types`, lowercase. */
export function wordsOf(name: string): string[] {
  const words: string[] = [];
  let cur = "";
  for (const c of name.toLowerCase()) {
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) cur += c;
    else {
      if (cur !== "") words.push(cur);
      cur = "";
    }
  }
  if (cur !== "") words.push(cur);
  return words;
}

/** Scripts that change files, watch, or are not a check of the code. */
const NOT_A_CHECK: ReadonlySet<string> = new Set([
  "fix",
  "write",
  "watch",
  "dev",
  "start",
  "serve",
  "e2e",
  "integration",
  "deploy",
  "release",
  "publish",
  "docker",
  "image",
  "storybook",
  "docs",
  "preview",
  "clean",
]);

/** What a script or task name says it is. */
export function kindOfName(name: string): CheckKind | undefined {
  const w = wordsOf(name);
  if (w.length === 0 || w.some((x) => NOT_A_CHECK.has(x))) return undefined;
  const has = (...names: string[]) => w.some((x) => names.includes(x));
  if (has("lint", "eslint", "biome", "ruff", "clippy", "stylelint")) return "lint";
  if (has("format", "fmt", "prettier") && has("check")) return "lint";
  if (has("typecheck", "types", "tsc", "typing", "typings", "mypy", "pyright")) return "typecheck";
  if (has("test", "tests", "unit", "vitest", "jest", "pytest")) return "test";
  if (has("build", "compile")) return "build";
  return undefined;
}

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Package manager flags that take a value. */
const VALUED: ReadonlySet<string> = new Set([
  "--filter",
  "-F",
  "--prefix",
  "-C",
  "--workspace",
  "--cwd",
  "-w",
]);
const NOT_SCRIPTS: ReadonlySet<string> = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "exec",
  "dlx",
  "x",
  "create",
  "init",
  "update",
  "upgrade",
  "publish",
  "pack",
  "link",
  "audit",
  "outdated",
  "cache",
  "config",
  "set",
  "get",
  "dedupe",
  "prune",
  "rebuild",
  "store",
  "version",
  "login",
  "logout",
  "whoami",
  "node",
]);

/** `pnpm run lint --fix`, `yarn test`, `npm t`: the package manager and the script it runs. */
export function packageScript(argv: readonly string[]): { manager: string; script: string } | undefined {
  const manager = programOf(argv);
  if (!PACKAGE_MANAGERS.has(manager)) return undefined;
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (VALUED.has(a) && !a.includes("=")) i++;
      continue;
    }
    rest.push(a);
  }
  const first = rest[0];
  if (first === undefined) return undefined;
  if (first === "run" || first === "run-script" || first === "rum" || first === "urn") {
    const script = rest[1];
    return script === undefined ? undefined : { manager, script };
  }
  if (first === "test" || first === "t" || first === "tst") return { manager, script: "test" };
  if (manager === "npm") return undefined;
  if (NOT_SCRIPTS.has(first)) return undefined;
  return { manager, script: first };
}

/** Programs that only start another one, and the words that sit between. */
const RUNNERS: ReadonlySet<string> = new Set([
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
  "bundle",
]);

const TASK_RUNNERS: ReadonlySet<string> = new Set([
  "make",
  "just",
  "task",
  "rake",
  "turbo",
  "nx",
  "lerna",
  "gulp",
]);

const LINT_PROGRAMS: ReadonlySet<string> = new Set([
  "eslint",
  "eslint_d",
  "oxlint",
  "flake8",
  "pylint",
  "pyflakes",
  "golangci-lint",
  "rubocop",
  "stylelint",
  "shellcheck",
  "hadolint",
  "markdownlint",
  "markdownlint-cli2",
  "standard",
  "ktlint",
  "swiftlint",
]);
const TYPECHECK_PROGRAMS: ReadonlySet<string> = new Set(["mypy", "pyright", "svelte-check", "vue-tsc"]);
const TEST_PROGRAMS: ReadonlySet<string> = new Set([
  "vitest",
  "jest",
  "mocha",
  "ava",
  "pytest",
  "py.test",
  "rspec",
  "phpunit",
  "tap",
  "karma",
  "nose2",
]);
const BUILD_PROGRAMS: ReadonlySet<string> = new Set([
  "vite",
  "next",
  "nuxt",
  "astro",
  "webpack",
  "rollup",
  "tsup",
  "parcel",
  "esbuild",
  "gatsby",
  "remix",
]);

const positionals = (args: readonly string[]): string[] => args.filter((a) => !a.startsWith("-"));

function installOf(program: string, args: readonly string[]): boolean {
  const sub = positionals(args)[0];
  if (program === "npm") return sub === "ci" || sub === "install" || sub === "i";
  if (program === "pnpm" || program === "bun") return sub === "install" || sub === "i";
  if (program === "yarn") return sub === undefined || sub === "install";
  if (program === "pip" || program === "pip3") return sub === "install";
  if (program === "poetry" || program === "bundle" || program === "composer") return sub === "install";
  if (program === "uv") return sub === "sync";
  return false;
}

function byProgram(program: string, args: readonly string[]): CommandKind | undefined {
  const sub = positionals(args)[0];
  if (LINT_PROGRAMS.has(program)) return "lint";
  if (TYPECHECK_PROGRAMS.has(program)) return "typecheck";
  if (TEST_PROGRAMS.has(program)) return "test";
  switch (program) {
    case "biome":
      return sub === "lint" || sub === "check" || sub === "ci" ? "lint" : undefined;
    case "ruff":
      return sub === undefined || sub === "check" ? "lint" : sub === "format" ? "lint" : undefined;
    case "prettier":
      return args.includes("--check") || args.includes("-c") || args.includes("--list-different")
        ? "lint"
        : undefined;
    case "tsc":
      return args.includes("--noEmit") || args.includes("-noEmit") ? "typecheck" : "build";
    case "go":
      return sub === "test" ? "test" : sub === "build" ? "build" : sub === "vet" ? "lint" : undefined;
    case "cargo":
      return sub === "test" || sub === "nextest"
        ? "test"
        : sub === "build"
          ? "build"
          : sub === "clippy"
            ? "lint"
            : sub === "check"
              ? "typecheck"
              : sub === "fmt" && args.includes("--check")
                ? "lint"
                : undefined;
    case "dotnet":
      return sub === "test" ? "test" : sub === "build" ? "build" : undefined;
    case "mvn":
    case "mvnw":
      return sub === "test" || sub === "verify"
        ? "test"
        : sub === "package" || sub === "compile"
          ? "build"
          : undefined;
    case "gradle":
    case "gradlew":
      return sub === "test" || sub === "check" ? "test" : sub === "build" ? "build" : undefined;
    case "deno":
      return sub === "test" ? "test" : sub === "lint" ? "lint" : sub === "check" ? "typecheck" : undefined;
    default:
      break;
  }
  if (BUILD_PROGRAMS.has(program)) return sub === "build" || args.includes("build") ? "build" : undefined;
  return undefined;
}

/** What one command does, with `scripts` as the package.json scripts of its folder when it runs one. */
export function classifyCommand(argv: readonly string[]): CommandKind | undefined {
  const program = programOf(argv);
  const script = packageScript(argv);
  if (script !== undefined) return kindOfName(script.script);
  if (PACKAGE_MANAGERS.has(program) && installOf(program, argv.slice(1))) return "install";
  if (installOf(program, argv.slice(1))) return "install";
  if (TASK_RUNNERS.has(program)) {
    for (const word of positionals(argv.slice(1))) {
      const kind = kindOfName(word);
      if (kind !== undefined) return kind;
    }
    return undefined;
  }
  // A runner in front of the real program: `npx eslint`, `uv run pytest`, `python -m pytest`.
  for (let i = 0; i < argv.length && i < 6; i++) {
    const word = argv[i] ?? "";
    const name = programOf([word]);
    if (i > 0 || !RUNNERS.has(name)) {
      const kind = byProgram(name, argv.slice(i + 1));
      if (kind !== undefined) return kind;
      if (!RUNNERS.has(name) && !word.startsWith("-")) return undefined;
    }
  }
  return undefined;
}

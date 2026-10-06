import { refuse } from "./args.ts";

/** One flag a script may type: the long name it becomes, and whether it takes a value. */
export interface UserFlag {
  /** The long name without dashes, like `detach`. */
  to: string;
  takes: boolean;
}
export type UserTable = Record<string, UserFlag>;
export interface Parsed {
  flags: { to: string; value: string }[];
  rest: string[];
}

export const flag = (to: string, takes = false): UserFlag => ({ to, takes });

/**
 * `-it`, `-e A=1`, `-eA=1`, `--env A=1`, `--env=A=1`. Stops at the first word that is not a flag,
 * or at `--`. A flag that is not in the table goes to `unknown`, which throws the refusal.
 */
export function parseFlagsOf(
  argv: readonly string[],
  table: UserTable,
  unknown: (name: string) => never,
): Parsed {
  const flags: Parsed["flags"] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    if (token === "--") {
      i++;
      break;
    }
    if (!token.startsWith("-") || token === "-") break;
    i++;
    if (token.startsWith("--")) {
      const at = token.indexOf("=");
      const name = at === -1 ? token : token.slice(0, at);
      const spec = Object.hasOwn(table, name) ? table[name] : undefined;
      if (spec === undefined) return unknown(name);
      if (!spec.takes) {
        if (at !== -1) refuse(`The docker flag ${name} takes no value.`);
        flags.push({ to: spec.to, value: "" });
        continue;
      }
      let value: string | undefined;
      if (at !== -1) value = token.slice(at + 1);
      else {
        value = argv[i];
        i++;
      }
      if (value === undefined) return refuse(`The docker flag ${name} needs a value.`);
      flags.push({ to: spec.to, value });
      continue;
    }
    // Short flags, possibly joined: `-it`, `-eNAME=1`.
    for (let c = 1; c < token.length; c++) {
      const name = `-${token[c]}`;
      const spec = Object.hasOwn(table, name) ? table[name] : undefined;
      if (spec === undefined) return unknown(name);
      if (!spec.takes) {
        flags.push({ to: spec.to, value: "" });
        continue;
      }
      let value = token.slice(c + 1);
      if (value === "") {
        const next = argv[i];
        if (next === undefined) return refuse(`The docker flag ${name} needs a value.`);
        value = next;
        i++;
      }
      flags.push({ to: spec.to, value });
      break;
    }
  }
  return { flags, rest: argv.slice(i) };
}

export const values = (p: Parsed, to: string): string[] =>
  p.flags.filter((f) => f.to === to).map((f) => f.value);
export const has = (p: Parsed, to: string): boolean => p.flags.some((f) => f.to === to);
export function single(p: Parsed, to: string): string | undefined {
  const found = values(p, to);
  if (found.length > 1) return refuse(`--${to} can be given once.`);
  return found[0];
}

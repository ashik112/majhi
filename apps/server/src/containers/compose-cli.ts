import { refuse, shown } from "./args.ts";
import { flag, has, parseFlagsOf, single, type UserTable, values } from "./user-flags.ts";

/** The compose commands a task may run. */
export const COMPOSE_VERBS = ["up", "down", "ps", "logs", "exec"] as const;
export type ComposeVerb = (typeof COMPOSE_VERBS)[number];

/** What a script typed after `docker compose`, read but not yet checked against a compose file. */
export interface ComposeInvocation {
  verb: ComposeVerb;
  /** Where the script ran. Files and the project directory resolve from here. */
  cwd: string;
  /** `-f` files as typed, in order. Empty: the default file names of the project directory. */
  files: string[];
  /** `--project-directory`, as typed. */
  projectDirectory?: string | undefined;
  /** `--env-file`, as typed: the file the `${VAR}` references of the compose file read from. */
  envFile?: string | undefined;
  profiles: string[];
  /** The services named after the verb (for `exec`, the one service). */
  services: string[];
  /** Said on the script's stderr: what majhi ignored. */
  notes: string[];
  // up
  build: boolean;
  noBuild: boolean;
  wait: boolean;
  noDeps: boolean;
  // down
  volumes: boolean;
  // ps
  all: boolean;
  quiet: boolean;
  servicesOnly: boolean;
  // logs
  tail?: string | undefined;
  timestamps: boolean;
  // exec
  env: string[];
  workdir?: string | undefined;
  command: string[];
}

const unsupportedFlag = (name: string): never =>
  refuse(
    `docker compose ${shown(name)} is not available in a task. Supported: ${COMPOSE_VERBS.join(", ")}, with -f, --env-file, --profile and the usual flags of each.`,
    "compose_unsupported_flag",
  );

const GLOBAL: UserTable = {
  "-f": flag("file", true),
  "--file": flag("file", true),
  "-p": flag("project", true),
  "--project-name": flag("project", true),
  "--project-directory": flag("directory", true),
  "--env-file": flag("env-file", true),
  "--profile": flag("profile", true),
  "--ansi": flag("ignored", true),
  "--progress": flag("ignored", true),
  "--parallel": flag("ignored", true),
  "--verbose": flag("ignored"),
  "--compatibility": flag("ignored"),
};

const UP: UserTable = {
  "-d": flag("detach"),
  "--detach": flag("detach"),
  "--build": flag("build"),
  "--no-build": flag("no-build"),
  "--wait": flag("wait"),
  "--wait-timeout": flag("ignored", true),
  "--no-deps": flag("no-deps"),
  "--remove-orphans": flag("ignored"),
  "--force-recreate": flag("ignored"),
  "--no-recreate": flag("ignored"),
  "--quiet-pull": flag("ignored"),
  "--no-color": flag("ignored"),
  "--no-log-prefix": flag("ignored"),
  "--pull": flag("ignored", true),
  "-V": flag("ignored"),
  "--renew-anon-volumes": flag("ignored"),
  "-y": flag("ignored"),
  "--yes": flag("ignored"),
  "-t": flag("ignored", true),
  "--timeout": flag("ignored", true),
};
const DOWN: UserTable = {
  "-v": flag("volumes"),
  "--volumes": flag("volumes"),
  "--remove-orphans": flag("ignored"),
  "-t": flag("ignored", true),
  "--timeout": flag("ignored", true),
};
const PS: UserTable = {
  "-a": flag("all"),
  "--all": flag("all"),
  "-q": flag("quiet"),
  "--quiet": flag("quiet"),
  "--services": flag("services"),
  "--format": flag("ignored", true),
  "--no-trunc": flag("ignored"),
  "--status": flag("ignored", true),
};
const LOGS: UserTable = {
  "--tail": flag("tail", true),
  "-n": flag("tail", true),
  "-t": flag("timestamps"),
  "--timestamps": flag("timestamps"),
  "--no-color": flag("ignored"),
  "--no-log-prefix": flag("ignored"),
};
const EXEC: UserTable = {
  "-T": flag("ignored"),
  "--no-TTY": flag("ignored"),
  "-e": flag("env", true),
  "--env": flag("env", true),
  "-w": flag("workdir", true),
  "--workdir": flag("workdir", true),
  "--index": flag("ignored", true),
};

const TABLES: Record<ComposeVerb, UserTable> = { up: UP, down: DOWN, ps: PS, logs: LOGS, exec: EXEC };

const isVerb = (word: string): word is ComposeVerb => (COMPOSE_VERBS as readonly string[]).includes(word);

/** Reads `docker compose [flags] <verb> [flags] [services]`. A flag that is not supported is refused with `compose_unsupported_flag`. */
export function parseCompose(argv: readonly string[], cwd: string): ComposeInvocation {
  const global = parseFlagsOf(argv, GLOBAL, unsupportedFlag);
  const [verb, ...afterVerb] = global.rest;
  if (verb === undefined)
    return refuse(`docker compose needs a command: ${COMPOSE_VERBS.join(", ")}.`, "command_not_available");
  if (!isVerb(verb)) {
    return refuse(
      `docker compose ${shown(verb)} is not available in a task. Supported: ${COMPOSE_VERBS.join(", ")}.`,
      "command_not_available",
    );
  }
  const own = parseFlagsOf(afterVerb, TABLES[verb], unsupportedFlag);
  const notes: string[] = [];
  if (has(global, "project")) notes.push("-p is ignored: the compose project is this task.");
  const files = values(global, "file");
  if (files.includes("-"))
    return refuse("A compose file is read from the task folder, not from stdin.", "compose_unsupported_flag");
  const services = own.rest;
  if (verb === "exec" && services.length < 2) {
    return refuse("docker compose exec needs a service and a command.");
  }
  // For exec everything after the service is the command, flags included (`exec app pip install -U six`).
  if ((verb === "exec" ? services.slice(0, 1) : services).some((s) => s.startsWith("-"))) {
    return refuse(
      "Put flags before the service names: docker compose up -d web.",
      "compose_unsupported_flag",
    );
  }
  return {
    verb,
    cwd,
    files,
    projectDirectory: single(global, "directory"),
    envFile: single(global, "env-file"),
    profiles: values(global, "profile"),
    services: verb === "exec" ? services.slice(0, 1) : services,
    notes,
    build: has(own, "build"),
    noBuild: has(own, "no-build"),
    wait: has(own, "wait"),
    noDeps: has(own, "no-deps"),
    volumes: has(own, "volumes"),
    all: has(own, "all"),
    quiet: has(own, "quiet"),
    servicesOnly: has(own, "services"),
    tail: single(own, "tail"),
    timestamps: has(own, "timestamps"),
    env: values(own, "env"),
    workdir: single(own, "workdir"),
    command: verb === "exec" ? services.slice(1) : [],
  };
}

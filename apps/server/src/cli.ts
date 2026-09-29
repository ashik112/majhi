import { statSync } from "node:fs";
import { formatChecks, runDoctor } from "./cli/doctor.ts";
import { InvalidConfigError, isPublicKeyPath, renderOverride } from "./cli/genOverride.ts";
import { loadConfig } from "./config/load.ts";
import { parseEnv, type ServerEnv } from "./env.ts";
import { errorMessage } from "./errors.ts";
import { generateKey } from "./secrets/store.ts";

/** Newline-separated paths from the host. Anything that is not a `.pub` path is dropped, so a private key is never mounted. */
function publicKeysFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(isPublicKeyPath);
}

const USAGE = `Usage: majhi <command>

Commands:
  gen-override     Print docker-compose.override.yml with one mount per workspace root
  gen-key          Print a new age identity for secrets.age (make up saves it to ~/.config/majhi/secrets.key)
  doctor [--json]  Check that majhi can run here. Exits 1 when a check fails
`;

/** The group of the Docker socket compose mounts into the server, when there is one. */
function dockerSocketGid(): number | undefined {
  try {
    return statSync(DOCKER_SOCKET).gid;
  } catch {
    return undefined;
  }
}

const DOCKER_SOCKET = "/var/run/docker.sock";

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }

  if (command === "gen-key") {
    process.stdout.write(`${await generateKey()}\n`);
    return 0;
  }

  let env: ServerEnv;
  try {
    env = parseEnv();
  } catch (err) {
    process.stderr.write(`${errorMessage(err)}\n`);
    return 1;
  }

  switch (command) {
    case "gen-override": {
      const { state } = await loadConfig(env);
      try {
        process.stdout.write(
          renderOverride(state, publicKeysFromEnv(process.env.MAJHI_SSH_PUBKEYS), dockerSocketGid()),
        );
        return 0;
      } catch (err) {
        if (!(err instanceof InvalidConfigError)) throw err;
        const lines = err.errors.map((e) => `  - ${e}`).join("\n");
        process.stderr.write(`Cannot generate the override: ${state.file} is invalid.\n${lines}\n`);
        return 1;
      }
    }
    case "doctor": {
      const unknown = args.filter((a) => a !== "--json");
      if (unknown.length > 0) {
        process.stderr.write(`Unknown option: ${unknown.join(" ")}\n\n${USAGE}`);
        return 2;
      }
      const checks = await runDoctor(env);
      const ok = checks.every((c) => c.status !== "fail");
      process.stdout.write(
        args.includes("--json") ? `${JSON.stringify({ ok, checks }, null, 2)}\n` : formatChecks(checks),
      );
      return ok ? 0 : 1;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exitCode = 1;
  },
);

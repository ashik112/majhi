import { formatChecks, runDoctor } from "./cli/doctor.ts";
import { InvalidConfigError, renderOverride } from "./cli/genOverride.ts";
import { loadConfig } from "./config/load.ts";
import { parseEnv, type ServerEnv } from "./env.ts";
import { errorMessage } from "./errors.ts";

const USAGE = `Usage: majhi <command>

Commands:
  gen-override     Print docker-compose.override.yml with one mount per workspace root
  doctor [--json]  Check that majhi can run here. Exits 1 when a check fails
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
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
        process.stdout.write(renderOverride(state));
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

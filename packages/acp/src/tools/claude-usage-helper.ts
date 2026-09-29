/**
 * Script run as `node --input-type=module -e <script> <adapter command> <timeout ms>`.
 * Passing the source with `-e` means nothing has to be found on disk at runtime,
 * so it works the same under tsx, in the esbuild bundle and in the Docker image.
 *
 * It loads the Claude Agent SDK from the ACP adapter's own install (the adapter
 * is found on PATH, so no new dependency), starts a query that never gets a user
 * message, asks the SDK for the plan usage, prints the limits as JSON and exits.
 * The usage call is answered by the Claude CLI from the claude.ai usage endpoint.
 * No prompt reaches a model.
 *
 * The SDK method is marked experimental. If it goes away, the script fails with
 * a clear message and the caller keeps the last numbers.
 */
export const CLAUDE_USAGE_SCRIPT = `
import { createRequire } from "node:module";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [adapter, timeoutMs] = process.argv.slice(1);

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return realpathSync(file);
    } catch {}
  }
  throw new Error(name + " is not on PATH");
}

async function main() {
  let root = dirname(findOnPath(adapter));
  for (let i = 0; i < 4 && !root.endsWith("claude-agent-acp"); i++) root = dirname(root);
  const sdkFile = createRequire(join(root, "package.json")).resolve("@anthropic-ai/claude-agent-sdk");
  const sdk = await import(pathToFileURL(sdkFile).href);

  const abort = new AbortController();
  const noMessages = (async function* () {
    await new Promise((resolve) => abort.signal.addEventListener("abort", resolve));
  })();
  const query = sdk.query({
    prompt: noMessages,
    options: { cwd: process.env.TMPDIR ?? "/tmp", abortController: abort, settingSources: [] },
  });
  const timer = setTimeout(() => {
    console.error("Timed out reading usage");
    query.close();
    process.exit(3);
  }, Number(timeoutMs));
  try {
    const read = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof read !== "function") throw new Error("This Claude SDK has no usage call");
    const usage = await read.call(query, { skipBehaviors: true });
    const limits = usage?.rate_limits ?? null;
    const keep = limits && {
      five_hour: limits.five_hour,
      seven_day: limits.seven_day,
      seven_day_opus: limits.seven_day_opus,
      seven_day_sonnet: limits.seven_day_sonnet,
      model_scoped: limits.model_scoped,
    };
    process.stdout.write(
      JSON.stringify({
        subscription_type: usage?.subscription_type ?? null,
        rate_limits_available: usage?.rate_limits_available === true,
        rate_limits: keep ?? null,
      }),
    );
  } finally {
    clearTimeout(timer);
    query.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  },
);
`;

import type { BaseEnv, Spawner } from "@majhi/acp";
import { errorMessage } from "../errors.ts";

/** Prints a self-contained HTML page to PDF. */
export type PdfPrinter = (html: string) => Promise<Buffer>;

/** A long document takes a few seconds; past this the print is stopped. */
const TIMEOUT_MS = 90_000;
/** Bigger output than this is not a document majhi made. */
const MAX_PDF = 200 * 1024 * 1024;
/** Prints at once; more wait their turn, so a burst of clicks does not start a container each. */
const CONCURRENCY = 2;

/**
 * The page goes in on stdin, the PDF comes out on stdout. Chromium's own sandbox needs user
 * namespaces that a container does not grant: the container is the sandbox here (no network, a
 * read-only root, no capabilities), and the page has no script and a CSP that allows none and
 * fetches nothing (html.ts). Chromium's switch for script off is not used: it stops printing.
 */
export const PRINT_SCRIPT = [
  "set -e",
  'd="$(mktemp -d)"',
  'cat > "$d/doc.html"',
  'chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-extensions --no-pdf-header-footer --user-data-dir="$d/profile" --print-to-pdf="$d/doc.pdf" "file://$d/doc.html" > "$d/log" 2>&1 || { tail -n 5 "$d/log" >&2; exit 1; }',
  'cat "$d/doc.pdf"',
].join("\n");

/**
 * The PDF printer: the runner image's Chromium (Playwright's build, already there for agents), in a
 * throwaway isolated runner container with no network and nothing mounted. The server image stays
 * without a browser (docs/DECISIONS.md, 2026-10-06).
 */
export function runnerPdfPrinter(deps: { spawner: Spawner; base: BaseEnv; timeoutMs?: number }): PdfPrinter {
  let running = 0;
  const waiting: (() => void)[] = [];
  const turn = async () => {
    if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
  };
  const done = () => {
    running -= 1;
    waiting.shift()?.();
  };
  return async (html) => {
    await turn();
    try {
      return await print(deps, html);
    } finally {
      done();
    }
  };
}

function print(deps: { spawner: Spawner; base: BaseEnv; timeoutMs?: number }, html: string): Promise<Buffer> {
  const limit = deps.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let errors = "";
    let settled = false;
    let kill = () => {};
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      reject(new Error(`Could not make the PDF: ${message}`));
    };
    const timer = setTimeout(() => fail(`stopped after ${Math.round(limit / 1000)} s.`), limit);
    deps
      .spawner({
        command: { command: "/bin/sh", args: ["-c", PRINT_SCRIPT] },
        env: { PATH: deps.base.PATH, HOME: "/tmp", ...(deps.base.LANG ? { LANG: deps.base.LANG } : {}) },
        cwd: "/tmp",
        scratch: true,
        isolated: true,
        limits: { cpus: "1", memory: "1g", cpuShares: "512" },
      })
      .then(
        (spawned) => {
          kill = spawned.kill;
          const { child } = spawned;
          child.stdout.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_PDF) return fail("the PDF is too big.");
            chunks.push(chunk);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            if (errors.length < 4096) errors += chunk.toString();
          });
          child.once("error", (err) => fail(errorMessage(err)));
          child.once("close", (code) => {
            if (settled) return;
            const pdf = Buffer.concat(chunks);
            if (code !== 0 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
              return fail(
                errors.trim().split("\n").slice(-2).join(" ") || `the printer exited with ${code}.`,
              );
            }
            settled = true;
            clearTimeout(timer);
            resolve(pdf);
          });
          child.stdin.on("error", () => {});
          child.stdin.end(html);
        },
        (err) => fail(errorMessage(err)),
      );
  });
}

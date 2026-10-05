/**
 * Puts text on the owner's clipboard with the first program that works: `pbcopy` on macOS,
 * `wl-copy`, `xclip` or `xsel` on Linux, `clip.exe` (else the Linux ones) on WSL2. The text goes to the program's stdin
 * and nowhere else: not its arguments (they show in `ps`), not the log, not an error.
 */
import type { RunFn } from "../ssh.ts";

const COPY_TIMEOUT_MS = 8_000;

export interface ClipboardProgram {
  name: string;
  args?: readonly string[];
}

export interface ClipboardDeps {
  run: RunFn;
  /** The absolute path of a program, or undefined when it is not there. */
  find: (name: string) => Promise<string | undefined>;
  /** `desktopEnv()`. */
  env: () => Promise<Record<string, string>>;
}

export const MAC_CLIPBOARD: readonly ClipboardProgram[] = [{ name: "pbcopy" }];
export const LINUX_CLIPBOARD: readonly ClipboardProgram[] = [
  { name: "wl-copy" },
  { name: "xclip", args: ["-selection", "clipboard"] },
  { name: "xsel", args: ["--clipboard", "--input"] },
];

/** True when a program took `text`. False when none exists or worked. Never throws. */
export async function clipboardCopy(
  deps: ClipboardDeps,
  programs: readonly ClipboardProgram[],
  text: string,
): Promise<boolean> {
  try {
    for (const program of programs) {
      const bin = await deps.find(program.name);
      if (bin === undefined) continue;
      const run = await deps.run(bin, program.args ?? [], {
        // pbcopy reads bytes as UTF-8 only when the locale says so.
        env: { LANG: "en_US.UTF-8", ...(await deps.env()) },
        timeoutMs: COPY_TIMEOUT_MS,
        input: text,
      });
      if (run.code === 0) return true;
    }
  } catch {
    // A lookup failed. Nothing took the text.
  }
  return false;
}

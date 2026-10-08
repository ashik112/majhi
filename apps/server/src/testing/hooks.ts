import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAJHI_HOOKS_DIR } from "@majhi/acp";
import { linkExecutable } from "@majhi/acp/testing";
import { ensureHooks } from "../runs/attribution.ts";

const MASTER_HOME = join(tmpdir(), "majhi-fast-bin", "hooks-home");

/**
 * Puts majhi's git hooks in `<majhiHome>/git-hooks` as hard links to one set that already ran, so
 * `ensureHooks` finds them current and writes nothing. Written fresh, each hook costs 200 ms the
 * first time git runs it on macOS (the system scans new executables).
 */
export async function seedHooks(majhiHome: string): Promise<void> {
  const from = await ensureHooks(MASTER_HOME);
  const to = join(majhiHome, MAJHI_HOOKS_DIR);
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) await linkExecutable(join(from, name), join(to, name));
}

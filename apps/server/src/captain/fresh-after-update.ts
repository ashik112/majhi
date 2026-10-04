import { readFile, writeFile } from "node:fs/promises";

/**
 * Once per majhi version: every captain thread gets a fresh session, so the captain works with this
 * version's instructions and tools instead of a resumed session's old ones. The version is written
 * only after every thread was refreshed; a failure leaves it for the next start. "dev" never counts
 * as a new version.
 */
export async function freshCaptainAfterUpdate(deps: {
  commit: string;
  file: string;
  chats: () => readonly string[];
  fresh: (chat: string) => Promise<void>;
}): Promise<string[]> {
  if (deps.commit === "dev") return [];
  const before = (await readFile(deps.file, "utf8").catch(() => "")).trim();
  if (before === deps.commit) return [];
  const done: string[] = [];
  for (const chat of deps.chats()) {
    await deps.fresh(chat);
    done.push(chat);
  }
  await writeFile(deps.file, `${deps.commit}\n`);
  return done;
}

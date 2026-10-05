import { readFile, writeFile } from "node:fs/promises";

/**
 * Once per majhi version: every captain thread gets a fresh session, so the captain works with this
 * version's instructions and tools instead of a resumed session's old ones. "dev" never counts as a
 * new version.
 *
 * The file holds the version on its first line and then each thread already refreshed for it, written
 * as each one finishes. A thread that fails does not stop the others and is tried again at the next
 * start, while the threads already done are not. Before, the version was written only after every
 * thread passed, so one failing thread made each restart refresh the earlier ones again, and each
 * time put another "moved to a fresh session" row in their transcripts.
 */
export async function freshCaptainAfterUpdate(deps: {
  commit: string;
  file: string;
  chats: () => readonly string[];
  fresh: (chat: string) => Promise<void>;
}): Promise<string[]> {
  if (deps.commit === "dev") return [];
  const [version, ...finished] = (await readFile(deps.file, "utf8").catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const done = new Set(version === deps.commit ? finished : []);
  const refreshed: string[] = [];
  for (const chat of deps.chats()) {
    if (done.has(chat)) continue;
    try {
      await deps.fresh(chat);
    } catch {
      continue;
    }
    done.add(chat);
    refreshed.push(chat);
    await writeFile(deps.file, `${[deps.commit, ...done].join("\n")}\n`);
  }
  return refreshed;
}

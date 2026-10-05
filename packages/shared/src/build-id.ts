/**
 * The build id of the web bundle (a hash of its emitted files, written into index.html) and of the
 * server that serves it. A tab opened before an update runs the old bundle against the new server:
 * when the two ids differ, the tab reloads itself at a safe moment.
 */
export type ReloadDecision = "none" | "reload" | "ask";

/** "dev" or nothing means a build with no id (dev server, tests): never reload for it. */
function known(id: string | undefined): id is string {
  return id !== undefined && id !== "" && id !== "dev";
}

/**
 * What a tab does about the server's build. Same build, or either one unknown: nothing. A different
 * build: reload now, or ask first when a composer holds text that was not sent.
 */
export function reloadDecision(input: {
  mine: string | undefined;
  server: string | undefined;
  unsent: boolean;
}): ReloadDecision {
  if (!known(input.mine) || !known(input.server) || input.mine === input.server) return "none";
  return input.unsent ? "ask" : "reload";
}

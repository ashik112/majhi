/** True when two commits are the same: one may be a prefix of the other. Empty and "dev" match nothing. */
export function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === "" || b === "" || a === "dev" || b === "dev") return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Newer code is ready when the checkout's HEAD differs from the running commit. An image built
 * without a commit (`dev`) cannot be compared, so it never claims an update: the first
 * `make up` after this feature ships bakes the commit in.
 */
export function isUpdateReady(running: string, onDisk: string | undefined): boolean {
  if (running === "" || running === "dev" || onDisk === undefined || onDisk === "") return false;
  return !sameCommit(running, onDisk);
}

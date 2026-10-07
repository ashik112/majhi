/**
 * Waits until `check` is true. It has no deadline of its own: the test's timeout is the only clock, so
 * a slow machine makes a test slower, never wrong. `what` names the wait for whoever reads the call.
 */
export async function until(check: () => boolean | Promise<boolean>, _what?: string): Promise<void> {
  while (!(await check())) await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

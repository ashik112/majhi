/**
 * The check after a deploy's runs end: the environment's address answers 2xx. Until the first green look,
 * failures are the new version still starting and are only remembered. From the first green look to the
 * end of the wait, every look must be green. A failure after that is a deploy that does not hold, so it
 * ends the check at once. Never green by the end is a failure with the last thing seen. An environment
 * with no address has nothing to look at: its deploy is live when its runs end.
 */

/** How long a check lasts. */
export const CHECK_SECONDS = 60;

export interface Check {
  /** The environment's `check` address. */
  health: string | undefined;
  waitSeconds: number;
}

export interface VerifyDeps {
  /** GET with no redirect and a short timeout, or undefined when nothing answered. */
  health(url: string): Promise<{ status: number } | undefined>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Time between looks. */
  everyMs: number;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

type Look = { green: true } | { green: false; detail: string };

async function look(verify: Check, deps: VerifyDeps): Promise<Look> {
  if (verify.health !== undefined) {
    const answer = await deps.health(verify.health);
    if (answer === undefined) return { green: false, detail: "the health address did not answer" };
    if (answer.status < 200 || answer.status > 299) {
      return { green: false, detail: `the health address answered ${answer.status}` };
    }
  }
  return { green: true };
}

export async function verifyDeploy(verify: Check, deps: VerifyDeps): Promise<VerifyResult> {
  if (verify.health === undefined) return { ok: true, detail: "The environment has no check address" };
  const deadline = deps.now() + verify.waitSeconds * 1000;
  let seenGreen = false;
  let last = "nothing was checked";
  for (;;) {
    const now = await look(verify, deps);
    if (now.green) {
      seenGreen = true;
      last = "green";
    } else {
      last = now.detail;
      if (seenGreen) {
        return { ok: false, detail: `It was up, then ${last}` };
      }
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(Math.min(deps.everyMs, Math.max(0, deadline - deps.now())));
  }
  return seenGreen
    ? { ok: true, detail: `Healthy for ${verify.waitSeconds} s` }
    : { ok: false, detail: `Not healthy after ${verify.waitSeconds} s: ${last}` };
}

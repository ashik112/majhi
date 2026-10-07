import type { DeployVerify } from "@majhi/shared";

/**
 * The check after a deploy's run ends. Until the first green look, failures are the new version still
 * starting and are only remembered. From the first green look to the end of the wait, every look must be
 * green: a health address that answers 2xx and a watch that reads ok. A failure after that is a deploy
 * that does not hold, so it ends the check at once. Never green by the end is a failure with the last thing seen.
 */

export interface VerifyDeps {
  /** GET with no redirect and a short timeout, or undefined when nothing answered. */
  health(url: string): Promise<{ status: number } | undefined>;
  /** One look at the watch, of the same workspace: ok, or what it says instead. */
  watch(id: string): Promise<{ ok: boolean; detail: string }>;
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

async function look(verify: DeployVerify, deps: VerifyDeps): Promise<Look> {
  if (verify.health !== undefined) {
    const answer = await deps.health(verify.health);
    if (answer === undefined) return { green: false, detail: "the health address did not answer" };
    if (answer.status < 200 || answer.status > 299) {
      return { green: false, detail: `the health address answered ${answer.status}` };
    }
  }
  if (verify.watch !== undefined) {
    const seen = await deps.watch(verify.watch);
    if (!seen.ok) return { green: false, detail: `the watch says ${seen.detail}` };
  }
  return { green: true };
}

export async function verifyDeploy(verify: DeployVerify, deps: VerifyDeps): Promise<VerifyResult> {
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

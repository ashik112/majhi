/**
 * Resumes the tasks (captain lanes included) that paused because their account was signed out, once
 * that account reads signed in again. A task waits on its own account only: another account signing
 * in changes nothing for it. Returns the ids it started.
 */
export async function resumeSignedIn(deps: {
  /** Tasks paused for a signed-out account. */
  paused: () => { id: string; team: string[] }[];
  /** The account a run of this agent in this task uses. */
  accountOf: (task: string, agent: string) => Promise<string | undefined>;
  /** Whether the account still needs a new sign-in (from its last check). */
  needsLogin: (account: string) => Promise<boolean>;
  start: (task: string) => Promise<unknown>;
}): Promise<string[]> {
  const resumed: string[] = [];
  for (const task of deps.paused()) {
    const lead = task.team[0];
    if (lead === undefined) continue;
    const account = await deps.accountOf(task.id, lead);
    if (account === undefined || (await deps.needsLogin(account))) continue;
    try {
      await deps.start(task.id);
      resumed.push(task.id);
    } catch (err) {
      console.error(`Could not resume ${task.id} after its account signed in: ${String(err)}`);
    }
  }
  return resumed;
}

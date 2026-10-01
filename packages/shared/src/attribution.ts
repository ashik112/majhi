import type { CommitsPatch } from "./settings.ts";

/**
 * Who made a commit (SPEC 5.7). The author is the org's commit identity. The committer is the agent
 * that made it, as "<agent> via majhi <majhi@majhi.local>", and the message ends with a
 * `Majhi-Task: <task>` trailer that links it to its task.
 */

export const COMMITTER_EMAIL = "majhi@majhi.local";
const VIA = " via majhi";

/** The trailer key that links a commit to its task. */
export const TASK_TRAILER = "Majhi-Task";

export interface GitPerson {
  name: string;
  email: string;
}

/** The committer for a commit an agent made. */
export function agentCommitter(agent: string): GitPerson {
  return { name: `${agent}${VIA}`, email: COMMITTER_EMAIL };
}

/** The agent behind a committer, or undefined when majhi did not commit it on an agent's behalf. */
export function agentOfCommitter(committer: GitPerson): string | undefined {
  if (committer.email !== COMMITTER_EMAIL || !committer.name.endsWith(VIA)) return undefined;
  const agent = committer.name.slice(0, -VIA.length);
  return agent === "" ? undefined : agent;
}

/** The message with the task trailer at its end. A message that already has it is left as it is. */
export function withTaskTrailer(message: string, task: string): string {
  const trailer = `${TASK_TRAILER}: ${task}`;
  const body = message.trimEnd();
  if (body.split("\n").includes(trailer)) return body;
  // Trailers join an existing trailer block; otherwise they follow a blank line.
  const last = body.split(/\n\n/).at(-1) ?? "";
  const inBlock = body.includes("\n\n") && last.split("\n").every((l) => /^[A-Za-z][A-Za-z0-9-]*: /.test(l));
  return `${body}${inBlock ? "\n" : "\n\n"}${trailer}`;
}

/**
 * Whether commits name the agent and the task: the project's own setting, else the org's, else
 * majhi's, else on. Any level can turn it off or back on for what is below it.
 */
export function attributionEnabled(levels: {
  project?: CommitsPatch | undefined;
  org?: CommitsPatch | undefined;
  global?: CommitsPatch | undefined;
}): boolean {
  return levels.project?.attribution ?? levels.org?.attribution ?? levels.global?.attribution ?? true;
}

import { isAbsolute } from "node:path";
import type { CommitSha, WikiFact, WikiPageId } from "@majhi/shared";
import { errorMessage } from "../../errors.ts";
import { BadReply, type Housekeeper, NO_SPEND, type Spend } from "../../memory/housekeeper.ts";
import { type DraftPage, type WriterPage, writerPageId } from "./draft.ts";
import { hintBlock } from "./hints.ts";
import { pagePrompt } from "./prompt.ts";
import { parsePageReply } from "./reply.ts";

export interface WriteInput {
  /** Only its `session` is used. */
  housekeeper: Pick<Housekeeper, "session">;
  org: string;
  project: string;
  /** The commit the export was made from. */
  sha: CommitSha;
  /** The clean export of that commit, an absolute folder. It is mounted read-only. */
  exportDir: string;
  /** What the tools found: leads for the writer. */
  facts: readonly WikiFact[];
  pages: readonly WriterPage[];
  /** Dollars this call may spend. A page not started when it is reached is skipped. Turns of a model with no price add nothing here. */
  capUsd?: number | undefined;
  /** Tokens this call may spend, counted for every model, priced or not (`tokensOf`). */
  capTokens?: number | undefined;
  /** Asked before each page: a reason to stop (the workspace's budget is used up), or undefined to go on. */
  stop?: (() => Promise<string | undefined>) | undefined;
  /** Called after each page is done or given up, with the pages done so far and the pages asked for. */
  progress?: ((done: number, total: number) => void) | undefined;
}

export interface WriteOutcome {
  /** Parsed, not yet checked: run each through `checkPage`. */
  drafts: DraftPage[];
  /** Pages the writer could not give a usable answer for, or that a broken session cut short. */
  failed: { page: WikiPageId; problem: string }[];
  /** Pages not started: the cap was reached, or the session ended before them. */
  skipped: WikiPageId[];
  /** Why pages were skipped: the cost cap, the token cap, or what `stop` said. Absent when none was. */
  stopped?: string | undefined;
  /** What the session cost. */
  usage: Spend;
  /** The Housekeeper agent that wrote. Absent when no page was asked. */
  agent: string | undefined;
}

/** The tokens a cap counts: input, output, reasoning and cache writes. Cache reads cost a tenth and are left out. */
export function tokensOf(spend: Spend): number {
  return spend.inputTokens + spend.outputTokens + spend.reasoningTokens + spend.cacheWriteTokens;
}

/** The id the spend of a project's wiki update is booked under. It is not a task: the workspace is named with it. */
export function wikiSpendId(org: string, project: string): string {
  return `wiki:${org}:${project}`;
}

/**
 * Writes pages in one read-only session of the Housekeeper on the export of one commit, one question
 * per page so a bad answer costs one page. Throws what `Housekeeper.session` throws before it starts
 * (no Housekeeper set, one that may not work for the workspace). A page whose two answers are both
 * unusable is listed in `failed`; any other error ends the session, lists that page and skips the rest.
 */
export async function writePages(input: WriteInput): Promise<WriteOutcome> {
  if (!isAbsolute(input.exportDir))
    throw new Error(`The export folder must be an absolute path, not ${input.exportDir}.`);
  const seen = new Set<WikiPageId>();
  const pages = input.pages.filter((p) => {
    const id = writerPageId(p);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (pages.length === 0) return { drafts: [], failed: [], skipped: [], usage: NO_SPEND, agent: undefined };

  const repo = { org: input.org, project: input.project, sha: input.sha, root: input.exportDir };
  const task = { id: wikiSpendId(input.org, input.project), org: input.org, project: input.project };
  const { value, agent, spent } = await input.housekeeper.session(
    task,
    { kind: "repo", root: input.exportDir },
    async (session) => {
      const out: Pick<WriteOutcome, "drafts" | "failed" | "skipped" | "stopped"> = {
        drafts: [],
        failed: [],
        skipped: [],
        stopped: undefined,
      };
      let ended = false;
      for (const [i, page] of pages.entries()) {
        const id = writerPageId(page);
        if (out.stopped === undefined && !ended) out.stopped = await reasonToStop(input, session.spent());
        if (ended || out.stopped !== undefined) {
          out.skipped.push(id);
          continue;
        }
        const hints = hintBlock(page, input.facts);
        try {
          const draft = await session.ask(
            pagePrompt({ repo, page, hints: hints.text, first: i === 0 }),
            parsePageReply(page, {
              org: input.org,
              project: input.project,
              commit: input.sha,
              known: new Set(hints.shown),
            }),
          );
          out.drafts.push(draft);
        } catch (err) {
          out.failed.push({ page: id, problem: errorMessage(err) });
          if (!(err instanceof BadReply)) ended = true;
        }
        input.progress?.(i + 1, pages.length);
      }
      return out;
    },
  );
  return { ...value, usage: spent, agent };
}

/** Why no further page should be started: a cap reached, or the caller's own reason. */
async function reasonToStop(input: WriteInput, spent: Spend): Promise<string | undefined> {
  if (input.capUsd !== undefined && spent.costUsd >= input.capUsd) {
    return `reached the cost cap of $${input.capUsd.toFixed(2)}`;
  }
  if (input.capTokens !== undefined && tokensOf(spent) >= input.capTokens) {
    return `reached the cap of ${input.capTokens.toLocaleString("en-US")} tokens`;
  }
  const rest = await input.stop?.();
  return rest === undefined ? undefined : `the workspace has no room to spend (${rest})`;
}

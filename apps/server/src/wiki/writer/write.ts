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
  /** Dollars this call may spend. A page not started when it is reached is skipped. */
  capUsd?: number | undefined;
}

export interface WriteOutcome {
  /** Parsed, not yet checked: run each through `checkPage`. */
  drafts: DraftPage[];
  /** Pages the writer could not give a usable answer for, or that a broken session cut short. */
  failed: { page: WikiPageId; problem: string }[];
  /** Pages not started: the cap was reached, or the session ended before them. */
  skipped: WikiPageId[];
  /** What the session cost. */
  usage: Spend;
  /** The Housekeeper agent that wrote. Absent when no page was asked. */
  agent: string | undefined;
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
      const out: Pick<WriteOutcome, "drafts" | "failed" | "skipped"> = {
        drafts: [],
        failed: [],
        skipped: [],
      };
      let ended = false;
      for (const [i, page] of pages.entries()) {
        const id = writerPageId(page);
        const capped = input.capUsd !== undefined && session.spent().costUsd >= input.capUsd;
        if (ended || capped) {
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
      }
      return out;
    },
  );
  return { ...value, usage: spent, agent };
}

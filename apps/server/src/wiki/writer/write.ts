import { isAbsolute } from "node:path";
import type { CommitSha, WikiFact, WikiPageId } from "@majhi/shared";
import {
  BadReply,
  type Housekeeper,
  type JobTask,
  NO_SPEND,
  type Parsed,
  type SessionMode,
  type Spend,
} from "../../memory/housekeeper.ts";
import { plainReason } from "../plain-error.ts";
import { type DraftPage, type WriterPage, writerPageId } from "./draft.ts";
import { hintBlock } from "./hints.ts";
import { pagePrompt } from "./prompt.ts";
import { parsePageReply } from "./reply.ts";

/** How a kind of page is asked for and read: the id of a page, its prompt (the first of a session also carries the rules) and the parser of the reply. */
export interface PageJob<P, D> {
  id: (page: P) => WikiPageId;
  prompt: (page: P, first: boolean) => string;
  parse: (page: P) => (text: string) => Parsed<D>;
}

export interface AskPagesInput<P, D> {
  /** Only its `session` is used. */
  housekeeper: Pick<Housekeeper, "session">;
  /** The id the spend is booked under, and the workspace and project it counts for (no project: the workspace's own pages). */
  task: JobTask;
  /** What the session may read: one repo's export, or several, read-only. */
  mode: Extract<SessionMode, { kind: "repo" }>;
  pages: readonly P[];
  job: PageJob<P, D>;
  /** Dollars this call may spend. A page not started when it is reached is skipped. Turns of a model with no price add nothing here. */
  capUsd?: number | undefined;
  /** Tokens this call may spend, counted for every model, priced or not (`tokensOf`). */
  capTokens?: number | undefined;
  /** Asked before each page: a reason to stop (the workspace's budget is used up), or undefined to go on. */
  stop?: (() => Promise<string | undefined>) | undefined;
  /** Called after each page is done or given up, with the pages done so far and the pages asked for. */
  progress?: ((done: number, total: number) => void) | undefined;
}

export interface WriteOutcome<D = DraftPage> {
  /** Parsed, not yet checked: run each through its check. */
  drafts: D[];
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

/** The id the spend of a project's wiki update is booked under (`*` for the workspace's own pages). It is not a task: the workspace is named with it. */
export function wikiSpendId(org: string, project: string | undefined): string {
  return `wiki:${org}:${project ?? "*"}`;
}

/** Why no further page should be started: a cap reached, or the caller's own reason. */
async function reasonToStop(
  input: Pick<AskPagesInput<unknown, unknown>, "capUsd" | "capTokens" | "stop">,
  spent: Spend,
): Promise<string | undefined> {
  if (input.capUsd !== undefined && spent.costUsd >= input.capUsd) {
    return `reached the cost cap of $${input.capUsd.toFixed(2)}`;
  }
  if (input.capTokens !== undefined && tokensOf(spent) >= input.capTokens) {
    return `reached the cap of ${input.capTokens.toLocaleString("en-US")} tokens`;
  }
  const rest = await input.stop?.();
  return rest === undefined ? undefined : `the workspace has no room to spend (${rest})`;
}

export interface WriteInput {
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
  /** What the owner or the captain said about a page, to write from. Absent: none. */
  notes?: ((page: WriterPage) => readonly string[]) | undefined;
  capUsd?: number | undefined;
  capTokens?: number | undefined;
  stop?: (() => Promise<string | undefined>) | undefined;
  progress?: ((done: number, total: number) => void) | undefined;
}

/**
 * Writes the pages of one project in one read-only session of the Housekeeper on the export of one commit. Throws
 * what `Housekeeper.session` throws before it starts (no Housekeeper set, one that may not work for the workspace).
 */
export async function writePages(input: WriteInput): Promise<WriteOutcome> {
  if (!isAbsolute(input.exportDir))
    throw new Error(`The export folder must be an absolute path, not ${input.exportDir}.`);
  const repo = { org: input.org, project: input.project, sha: input.sha, root: input.exportDir };
  return askPages<WriterPage, DraftPage>({
    housekeeper: input.housekeeper,
    task: { id: wikiSpendId(input.org, input.project), org: input.org, project: input.project },
    mode: { kind: "repo", root: input.exportDir },
    pages: input.pages,
    job: {
      id: writerPageId,
      prompt: (page, first) =>
        pagePrompt({
          repo,
          page,
          hints: hintBlock(page, input.facts).text,
          first,
          notes: input.notes?.(page) ?? [],
        }),
      parse: (page) =>
        parsePageReply(page, {
          org: input.org,
          project: input.project,
          commit: input.sha,
          known: new Set(hintBlock(page, input.facts).shown),
        }),
    },
    capUsd: input.capUsd,
    capTokens: input.capTokens,
    stop: input.stop,
    progress: input.progress,
  });
}

/**
 * Asks the writer for each page in one session, one question per page so a bad answer costs one page. A page whose two
 * answers are both unusable is listed in `failed`; any other error ends the session, lists that page and skips the rest.
 * A page asked twice is asked once.
 */
export async function askPages<P, D>(input: AskPagesInput<P, D>): Promise<WriteOutcome<D>> {
  const seen = new Set<WikiPageId>();
  const pages = input.pages.filter((p) => {
    const id = input.job.id(p);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (pages.length === 0) return { drafts: [], failed: [], skipped: [], usage: NO_SPEND, agent: undefined };

  const { value, agent, spent } = await input.housekeeper.session(input.task, input.mode, async (session) => {
    const out: Pick<WriteOutcome<D>, "drafts" | "failed" | "skipped" | "stopped"> = {
      drafts: [],
      failed: [],
      skipped: [],
      stopped: undefined,
    };
    let ended = false;
    for (const [i, page] of pages.entries()) {
      const id = input.job.id(page);
      if (out.stopped === undefined && !ended) out.stopped = await reasonToStop(input, session.spent());
      if (ended || out.stopped !== undefined) {
        out.skipped.push(id);
        continue;
      }
      try {
        out.drafts.push(await session.ask(input.job.prompt(page, i === 0), input.job.parse(page)));
      } catch (err) {
        out.failed.push({ page: id, problem: plainReason(err) });
        if (!(err instanceof BadReply)) ended = true;
      }
      input.progress?.(i + 1, pages.length);
    }
    return out;
  });
  return { ...value, usage: spent, agent };
}

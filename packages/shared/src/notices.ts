import { z } from "zod";
import { DecisionLinkSchema } from "./inbox.ts";

/**
 * The bell's feed: what happened since the owner last looked. A notice is read from the records each
 * event already lives in (decisions, client rooms, task history, deploys, incidents, the update file)
 * and stores nothing of its own. The only stored values are the owner's "seen up to" time and the few
 * rows they read one by one.
 */

export const NoticeKindSchema = z.enum([
  "decision",
  "client-message",
  "client-reply",
  "task-review",
  "task-done",
  "task-paused",
  "deploy",
  "incident",
  "bug",
  "update",
]);
export type NoticeKind = z.infer<typeof NoticeKindSchema>;

/** Where a row opens: a decision's home, or one of the pages that holds the rest. */
export const NoticeLinkSchema = z.union([
  DecisionLinkSchema,
  z.object({ kind: z.literal("page"), page: z.enum(["projects", "captain", "watch", "setup"]) }),
]);
export type NoticeLink = z.infer<typeof NoticeLinkSchema>;

export const NoticeSchema = z.object({
  /** Stable for the same event: `decision:<id>`, `client:<room>:<item>`, `task:<id>:<event>`, `deploy:<id>`, `incident:<id>:opened`. */
  id: z.string().min(1).max(300),
  kind: NoticeKindSchema,
  /** The workspace; absent for what belongs to none (a sign-in, an update). */
  org: z.string().optional(),
  /** When it happened (ISO). */
  at: z.string(),
  /** What happened, in one short plain line. */
  subject: z.string().min(1).max(200),
  /** The task title, or the speaker and words. One line. */
  detail: z.string().max(300).optional(),
  /** It waits for the owner: a decision. Such a row carries `answer` when one click can answer it. */
  needsYou: z.boolean(),
  read: z.boolean(),
  link: NoticeLinkSchema,
  /** A row that waits for the owner and has no one-click answer: the label of the button that opens what it needs ("Sign in"). */
  openLabel: z.string().max(40).optional(),
  /** The decision's main answer, wired to the same action as Needs you. */
  answer: z
    .object({
      decision: z.string().min(1).max(300),
      option: z.string().min(1),
      label: z.string().min(1),
      /** Who suggests which answer, in a few words: "Captain says merge." */
      says: z.string().max(200).optional(),
    })
    .optional(),
});
export type Notice = z.infer<typeof NoticeSchema>;

export const NoticesListInputSchema = z.object({ org: z.string().optional() });

export const NoticeListSchema = z.object({
  /** Newest first, at most a week back and 100 rows. */
  notices: z.array(NoticeSchema),
  unread: z.number().int().nonnegative(),
  /** Unread rows that wait for the owner: the badge turns red when this is above zero. */
  unreadNeedsYou: z.number().int().nonnegative(),
});
export type NoticeList = z.infer<typeof NoticeListSchema>;

/** Read everything up to a time (the newest row on screen), or one row. */
export const NoticesMarkReadInputSchema = z.union([
  z.object({ upTo: z.string().min(1).max(40) }),
  z.object({ id: z.string().min(1).max(300) }),
]);
export type NoticesMarkReadInput = z.infer<typeof NoticesMarkReadInputSchema>;

/** How far back the feed reads, and the most rows it returns. */
export const NOTICE_DAYS = 7;
export const NOTICE_LIMIT = 100;

import {
  type CommitSha,
  type WikiFactId,
  WikiFactIdSchema,
  WikiKnownRoleSchema,
  wikiPageKind,
} from "@majhi/shared";
import { z } from "zod";
import { type Parsed, parseJson } from "../../memory/housekeeper.ts";
import {
  type DraftClaim,
  type DraftDiagram,
  type DraftPage,
  type DraftRole,
  type WriterPage,
  writerPageId,
} from "./draft.ts";

/** What the model writes for one page, as JSON. The citations are only what it says: the checker looks at them. */
const SentenceSchema = z.string().trim().min(1).max(800);
const StatusSchema = z.enum(["proven", "guessed"]);
const CitationSchema = z.object({
  path: z.string().trim().min(1).max(400),
  lines: z.tuple([z.number().int(), z.number().int()]),
});
const ProofSchema = {
  citations: z.array(CitationSchema).max(12).default([]),
  status: StatusSchema,
  /** Ids of the facts it rests on. Ones that are not in the facts given are dropped. */
  facts: z.array(z.string().max(200)).max(20).default([]),
};
const KeySchema = z.string().trim().min(1).max(60);

export const ITEM_LIMIT = 60;

export const PageReplySchema = z
  .object({
    summary: z.array(SentenceSchema).min(1).max(5),
    /** Overview only. */
    roles: z
      .array(
        z.object({
          role: WikiKnownRoleSchema,
          where: z.string().trim().min(1).max(200),
          tech: z.string().trim().min(1).max(120),
          /** One plain sentence saying it, like "The API is a Django app in `services/api`." */
          text: SentenceSchema,
          ...ProofSchema,
        }),
      )
      .max(20)
      .default([]),
    /** The page's claims in order. A flow's are its steps. */
    items: z
      .array(
        z.object({
          text: SentenceSchema,
          ...ProofSchema,
          /** Flow steps: who does it. */
          actor: z.string().trim().min(1).max(40).optional(),
          /** Flow steps: a few words for the arrow. */
          label: z.string().trim().min(1).max(40).optional(),
        }),
      )
      .max(ITEM_LIMIT)
      .default([]),
    /** Not for flows: their picture is drawn from the steps. */
    diagram: z
      .object({
        title: z.string().trim().min(1).max(80),
        nodes: z
          .array(
            z.object({
              id: KeySchema,
              label: z.string().trim().min(1).max(60),
              sub: z.string().trim().min(1).max(120).optional(),
              /** What the box is, from the same list as the roles. Draws its colored tag. */
              role: WikiKnownRoleSchema.optional(),
            }),
          )
          .min(1)
          .max(30),
        edges: z
          .array(
            z.object({
              from: KeySchema,
              to: KeySchema,
              label: z.string().trim().min(1).max(60).optional(),
              /** A call over the network, a job on a queue, or a read and write of data. Draws the line's color. */
              type: z.enum(["http", "queue", "data"]).optional(),
              /** The number of the item that shows this line. Without it, the line is drawn as a guess. */
              claim: z.number().int().positive().optional(),
            }),
          )
          .max(60)
          .default([]),
      })
      .optional(),
    could_not_determine: z
      .array(
        z.object({
          topic: z.string().trim().min(1).max(200),
          why: z.string().trim().min(1).max(500),
        }),
      )
      .max(20)
      .default([]),
  })
  .refine(
    (r) => r.roles.length + r.items.length > 0,
    "Write at least one item, or say in could_not_determine why you cannot.",
  );
export type PageReply = z.infer<typeof PageReplySchema>;

interface Context {
  org: string;
  project: string;
  commit: CommitSha;
  /** The facts the writer was given: a fact id it names that is not here is dropped. */
  known: ReadonlySet<string>;
}

function claimOf(
  r: {
    text: string;
    status: "proven" | "guessed";
    citations: PageReply["items"][number]["citations"];
    facts: string[];
  },
  known: ReadonlySet<string>,
): DraftClaim {
  const facts: WikiFactId[] = [];
  for (const id of new Set(r.facts)) {
    const parsed = WikiFactIdSchema.safeParse(id);
    if (parsed.success && known.has(id)) facts.push(parsed.data);
  }
  return { text: r.text, proven: r.status === "proven", citations: r.citations, facts };
}

/** The model's reply as a draft page. Roles come first among the claims, then the items. */
export function draftOf(page: WriterPage, reply: PageReply, ctx: Context): DraftPage {
  const kind = wikiPageKind(writerPageId(page));
  if (kind === "gaps") throw new Error("The Gaps page is not written by the model.");
  const roleRows = kind === "overview" ? reply.roles : [];
  const claims: DraftClaim[] = [
    ...roleRows.map((r) => claimOf(r, ctx.known)),
    ...reply.items.map((i) => ({
      ...claimOf(i, ctx.known),
      ...(i.actor === undefined ? {} : { actor: i.actor }),
      ...(i.label === undefined ? {} : { label: i.label }),
    })),
  ];
  const roles: DraftRole[] = roleRows.map((r, claim) => ({
    role: r.role,
    where: r.where,
    tech: r.tech,
    claim,
  }));
  const diagram: DraftDiagram | undefined =
    kind === "flow" || reply.diagram === undefined
      ? undefined
      : {
          title: reply.diagram.title,
          nodes: reply.diagram.nodes,
          edges: reply.diagram.edges.map((e) => ({
            from: e.from,
            to: e.to,
            label: e.label,
            type: e.type,
            // Item n is the claim after the role claims.
            claim: e.claim === undefined ? undefined : roleRows.length + e.claim - 1,
          })),
        };
  return {
    id: writerPageId(page),
    kind,
    org: ctx.org,
    project: ctx.project,
    commit: ctx.commit,
    title: pageTitle(page),
    summary: reply.summary,
    claims,
    roles,
    diagram,
    couldNot: reply.could_not_determine,
  };
}

/** The title a page has: fixed by the plan, so a rewrite does not rename it. */
export function pageTitle(page: WriterPage): string {
  switch (page.kind) {
    case "overview":
      return "Overview";
    case "infra":
      return "Infra and deploy";
    case "component":
    case "flow":
      return page.title;
  }
}

/** The kind-specific rules a reply must meet beyond the schema. A problem is given back to the model. */
function problemWith(page: WriterPage, reply: PageReply): string | undefined {
  if (page.kind === "flow" && reply.items.length < 2) {
    return "items: a flow has at least two steps. Cover the path from its first trigger to its last effect.";
  }
  if (page.kind === "overview" && reply.roles.length === 0 && reply.items.length === 0) {
    return "roles: name each role you can find, or say in could_not_determine why you cannot.";
  }
  return undefined;
}

/** Parses the model's text for `page`: tolerant of a code fence around the JSON, strict about its shape. */
export function parsePageReply(page: WriterPage, ctx: Context): (text: string) => Parsed<DraftPage> {
  return (text) => {
    const parsed = parseJson(text, PageReplySchema);
    if (!parsed.ok) return parsed;
    const problem = problemWith(page, parsed.value);
    if (problem !== undefined) return { ok: false, problem };
    return { ok: true, value: draftOf(page, parsed.value, ctx) };
  };
}

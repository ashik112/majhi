import { WikiKnownRoleSchema } from "@majhi/shared";
import { z } from "zod";
import { type Parsed, parseJson } from "../../memory/housekeeper.ts";
import type { DraftRole } from "./draft.ts";
import type {
  GuessedLink,
  WorkspaceDraft,
  WorkspaceDraftClaim,
  WorkspaceWriterPage,
} from "./workspace-draft.ts";
import { workspacePageId } from "./workspace-draft.ts";

/** What the model writes for one workspace page, as JSON. The citations are only what it says: the checker looks at them, repo by repo. */
const Sentence = z.string().trim().min(1).max(800);
const Citation = z.object({
  repo: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(400),
  lines: z.tuple([z.number().int(), z.number().int()]),
});
const Proof = {
  citations: z.array(Citation).max(12).default([]),
  status: z.enum(["proven", "guessed"]),
};

export const WorkspaceReplySchema = z
  .object({
    summary: z.array(Sentence).min(1).max(5),
    /** Overview only: one tile per project. */
    repos: z
      .array(
        z.object({
          project: z.string().trim().min(1).max(120),
          role: WikiKnownRoleSchema,
          tech: z.string().trim().min(1).max(120),
          text: Sentence,
          ...Proof,
        }),
      )
      .max(40)
      .default([]),
    items: z
      .array(
        z.object({
          text: Sentence,
          ...Proof,
          actor: z.string().trim().min(1).max(40).optional(),
          label: z.string().trim().min(1).max(40).optional(),
        }),
      )
      .max(60)
      .default([]),
    guessed_links: z
      .array(
        z.object({
          from: z.string().trim().min(1).max(120),
          to: z.string().trim().min(1).max(120),
          label: z.string().trim().min(1).max(40).optional(),
          why: z.string().trim().min(1).max(300),
        }),
      )
      .max(20)
      .default([]),
    could_not_determine: z
      .array(z.object({ topic: z.string().trim().min(1).max(200), why: z.string().trim().min(1).max(500) }))
      .max(20)
      .default([]),
  })
  .refine(
    (r) => r.repos.length + r.items.length > 0,
    "Write at least one item, or say in could_not_determine why you cannot.",
  );
export type WorkspaceReply = z.infer<typeof WorkspaceReplySchema>;

const claim = (r: {
  text: string;
  status: "proven" | "guessed";
  citations: WorkspaceReply["items"][number]["citations"];
  actor?: string | undefined;
  label?: string | undefined;
}): WorkspaceDraftClaim => ({
  text: r.text,
  proven: r.status === "proven",
  citations: r.citations,
  facts: [],
  ...(r.actor === undefined ? {} : { actor: r.actor }),
  ...(r.label === undefined ? {} : { label: r.label }),
});

export function workspaceTitle(page: WorkspaceWriterPage): string {
  return page.kind === "flow" ? page.title : "System overview";
}

/** The model's reply as a draft. Tiles come first among the claims, then the items. A tile or a guessed link naming a project the workspace does not have is dropped. */
export function workspaceDraftOf(
  page: WorkspaceWriterPage,
  reply: WorkspaceReply,
  ctx: { org: string; projects: ReadonlySet<string> },
): WorkspaceDraft {
  const tiles = page.kind === "overview" ? reply.repos.filter((r) => ctx.projects.has(r.project)) : [];
  const roles: DraftRole[] = tiles.map((r, i) => ({
    role: r.role,
    where: r.project,
    tech: r.tech,
    claim: i,
  }));
  const guessedLinks: GuessedLink[] =
    page.kind === "overview"
      ? reply.guessed_links.filter(
          (g) => g.from !== g.to && ctx.projects.has(g.from) && ctx.projects.has(g.to),
        )
      : [];
  return {
    id: workspacePageId(page),
    kind: page.kind,
    org: ctx.org,
    title: workspaceTitle(page),
    summary: reply.summary,
    claims: [...tiles.map(claim), ...reply.items.map(claim)],
    roles,
    guessedLinks,
    couldNot: reply.could_not_determine,
  };
}

/** Parses the model's text for `page`: tolerant of a code fence around the JSON, strict about its shape. */
export function parseWorkspaceReply(
  page: WorkspaceWriterPage,
  ctx: { org: string; projects: ReadonlySet<string> },
): (text: string) => Parsed<WorkspaceDraft> {
  return (text) => {
    const parsed = parseJson(text, WorkspaceReplySchema);
    if (!parsed.ok) return parsed;
    if (page.kind === "flow" && parsed.value.items.length < 2) {
      return {
        ok: false,
        problem:
          "items: a flow has at least two steps. Cover the path from its first trigger to its last effect.",
      };
    }
    if (page.kind === "overview" && parsed.value.repos.length + parsed.value.items.length === 0) {
      return {
        ok: false,
        problem: "repos: name each repository, or say in could_not_determine why you cannot.",
      };
    }
    return { ok: true, value: workspaceDraftOf(page, parsed.value, ctx) };
  };
}

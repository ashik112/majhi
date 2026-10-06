import { z } from "zod";
import { DiagramSpecSchema } from "./diagram.ts";
import { IdSchema } from "./ids.ts";
import type { WikiOrgPatch, WikiPatch } from "./settings.ts";

/**
 * The project wiki (docs/design/wiki.md, section 4). Tools find facts with evidence; a read-only agent
 * writes pages from them; a checker drops any claim whose cited lines do not hold. Every shape here is
 * checked by zod where it crosses a boundary: the database, the command endpoint, the fact files the reader
 * container writes and the writer's JSON.
 *
 * A unit or a data store is a `unit` or `store` fact, a line between two of them is a `link` fact, an address is an
 * `endpoint` fact with its call sites as sources, and the owner's answer is an `OwnerAnswer`.
 */

/** Bumped when the writer rules change. A page written by older rules still reads, and is rewritten on the next update. */
export const WIKI_RULES = 1;

/** The most one update may spend, in dollars. The writer stops there and the rest of the pages stay as they were. */
export const WIKI_COST_CAP_USD = 5;

/**
 * The most tokens one update may spend (input, output, reasoning and cache writes; cache reads are nearly free).
 * The dollar cap cannot see a turn of a model with no price, so this one holds for every model. Phase 0 measured
 * about 45,000 tokens a page, so this is about 33 pages.
 */
export const WIKI_TOKEN_CAP = 1_500_000;

// Identity -------------------------------------------------------------------------------

/** A git commit: 40 hex digits, or 64 in a repo that uses SHA-256. */
export const CommitShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "Not a full commit hash")
  .brand<"CommitSha">();
export type CommitSha = z.infer<typeof CommitShaSchema>;

/** The SHA-256 of the cited lines, in lowercase hex. Not a commit: the brand keeps the two apart. */
export const ContentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Not a SHA-256 hash")
  .brand<"ContentHash">();
export type ContentHash = z.infer<typeof ContentHashSchema>;

export const WIKI_PAGE_KINDS = ["overview", "component", "flow", "infra", "gaps"] as const;
export const WikiPageKindSchema = z.enum(WIKI_PAGE_KINDS);
export type WikiPageKind = z.infer<typeof WikiPageKindSchema>;

/** Kinds there is one of per scope. Their id is the kind itself. */
const SINGLE_PAGE_KINDS = ["overview", "infra", "gaps"] as const;
/** Kinds there are many of. Their id is `<kind>:<slug>`. */
const NAMED_PAGE_KINDS = ["component", "flow"] as const;

/** A page id is fixed by its kind: `overview`, `infra`, `gaps`, `component:<slug>` or `flow:<slug>`. */
export const WikiPageIdSchema = z
  .string()
  .regex(
    /^(?:overview|infra|gaps|(?:component|flow):[a-z0-9][a-z0-9-]{0,62})$/,
    "Use overview, infra, gaps, component:<name> or flow:<name>",
  )
  .brand<"WikiPageId">();
export type WikiPageId = z.infer<typeof WikiPageIdSchema>;

export type WikiPageRef =
  | { kind: (typeof SINGLE_PAGE_KINDS)[number] }
  | { kind: (typeof NAMED_PAGE_KINDS)[number]; slug: string };

/** The id of a page. Throws on a slug that is not lowercase letters, digits and dashes. */
export function wikiPageId(ref: WikiPageRef): WikiPageId {
  return WikiPageIdSchema.parse("slug" in ref ? `${ref.kind}:${ref.slug}` : ref.kind);
}

/** The kind a page id names. */
export function wikiPageKind(id: WikiPageId): WikiPageKind {
  return WikiPageKindSchema.parse(id.split(":", 1)[0]);
}

export const WIKI_FACT_KINDS = [
  "unit",
  "role",
  "store",
  "entry",
  "endpoint",
  "call",
  "link",
  "component",
  "step",
] as const;
export const WikiFactKindSchema = z.enum(WIKI_FACT_KINDS);
export type WikiFactKind = z.infer<typeof WikiFactKindSchema>;

/** `<repo>:<kind>:<slug>`. The tools build it, so the same fact keeps its id between runs. */
export const WikiFactIdSchema = z
  .string()
  .regex(
    new RegExp(`^[a-z0-9][a-z0-9-]{0,62}:(?:${WIKI_FACT_KINDS.join("|")}):[A-Za-z0-9._:/@#-]{1,160}$`),
    "Not a fact id",
  )
  .brand<"WikiFactId">();
export type WikiFactId = z.infer<typeof WikiFactIdSchema>;

/** The id of a fact. Throws when the slug has characters outside letters, digits and `._:/@#-`. */
export function wikiFactId(repo: string, kind: WikiFactKind, slug: string): WikiFactId {
  return WikiFactIdSchema.parse(`${repo}:${kind}:${slug}`);
}

// Roles, proof and sources -----------------------------------------------------------------

/** What a part of the system does. Picked from this list only when a fact backs it, else `unknown`. */
export const WIKI_ROLES = [
  "frontend",
  "backend",
  "worker",
  "queue",
  "cache",
  "database",
  "auth",
  "outside",
  "library",
  "infra",
  "unknown",
] as const;
export const WikiRoleSchema = z.enum(WIKI_ROLES);
export type WikiRole = z.infer<typeof WikiRoleSchema>;
/** A role a `role` fact can state: `unknown` is the lack of a fact. */
export const WikiKnownRoleSchema = WikiRoleSchema.exclude(["unknown"]);
export type WikiKnownRole = z.infer<typeof WikiKnownRoleSchema>;

/**
 * How a link or a role is known, strongest first: a file declares it, an exact match (method and path, the
 * same queue name), a config value points at it, the owner said so, or the model guessed.
 */
export const WIKI_BASES = ["declared", "exact", "config", "owner", "guessed"] as const;
export const WikiBasisSchema = z.enum(WIKI_BASES);
export type WikiBasis = z.infer<typeof WikiBasisSchema>;
/** What a tool can say: a tool never guesses. */
export const WikiFactBasisSchema = WikiBasisSchema.exclude(["guessed"]);
export type WikiFactBasis = z.infer<typeof WikiFactBasisSchema>;

/** A path inside a repo: relative, no `.` or `..` part, no backslash. Containment in the export is checked again where files are read. */
export const RepoPathSchema = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      p.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a path inside the repo, without a leading slash, ./ or ..",
  );

/** `[start, end]`, both inclusive and 1-based. */
export const LineRangeSchema = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([start, end]) => end >= start, "The end line comes before the start line");
export type LineRange = z.infer<typeof LineRangeSchema>;

/** What the writer cites: a place in a repo. The checker adds the repo, the commit and the hash. */
export const WikiCitationSchema = z.object({ path: RepoPathSchema, lines: LineRangeSchema });
export type WikiCitation = z.infer<typeof WikiCitationSchema>;

/** A place in a repo at a commit, with the hash of the cited lines so a change in them is seen. */
export const WikiSourceSchema = WikiCitationSchema.extend({
  repo: IdSchema,
  commit: CommitShaSchema,
  hash: ContentHashSchema,
});
export type WikiSource = z.infer<typeof WikiSourceSchema>;

// Facts: from tools, never from the model ---------------------------------------------------

/** An outside call or route method. */
export const WIKI_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"] as const;

/** Where a request or a job starts. Each kind carries what it needs: a route has a method and a path, a timer a schedule. */
export const WikiEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http"),
    method: z.enum(WIKI_HTTP_METHODS),
    path: z.string().min(1).max(400),
    handler: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("queue"),
    /** The queue, topic or task name the consumer takes. */
    name: z.string().min(1).max(200),
    handler: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("timer"),
    /** A cron line or an interval, as written. */
    schedule: z.string().min(1).max(200),
    handler: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("command"),
    name: z.string().min(1).max(200),
    handler: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("socket"),
    name: z.string().min(1).max(200),
    handler: z.string().max(200).optional(),
  }),
]);
export type WikiEntry = z.infer<typeof WikiEntrySchema>;

export const WIKI_LINK_TYPES = ["http", "queue", "data", "lib", "deploy"] as const;
export const WikiLinkTypeSchema = z.enum(WIKI_LINK_TYPES);
export type WikiLinkType = z.infer<typeof WikiLinkTypeSchema>;

/** The path of a call: starts with `/`, no query, no empty part, no `..`, and `{}` where the code fills a part in. */
export const CallPathSchema = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (p) =>
      p.startsWith("/") &&
      !p.includes("?") &&
      !p.includes("#") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      (p === "/" ||
        p
          .slice(1)
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== "..")),
    "Use an absolute path without a query",
  );

export const WIKI_BOUNDARIES = ["database", "queue", "outside", "repo"] as const;

const factBase = {
  id: WikiFactIdSchema,
  repo: IdSchema,
  /** The lines that show it. A fact without evidence is not a fact. */
  sources: z.array(WikiSourceSchema).min(1).max(12),
  basis: WikiFactBasisSchema,
};

export const WikiFactSchema = z
  .discriminatedUnion("kind", [
    /** Something deployed or run: a compose service, a Kubernetes workload, a package. Names and ports only, never env values. */
    z.object({
      ...factBase,
      kind: z.literal("unit"),
      name: z.string().min(1).max(120),
      role: WikiRoleSchema,
      /** Where it runs: Docker, Kubernetes, Vercel, an npm package. */
      runsOn: z.string().max(60).optional(),
      image: z.string().max(200).optional(),
      ports: z.array(z.number().int().min(1).max(65535)).max(20).default([]),
      /** Names of the units it waits for. */
      dependsOn: z.array(z.string().min(1).max(120)).max(40).default([]),
      /** Built from this repo's code (a compose `build`), as opposed to started from a published image. */
      builds: z.boolean().optional(),
    }),
    /** A role the stack shows: Postgres is a database, Celery is a worker. `where` is a folder or a unit name. */
    z.object({
      ...factBase,
      kind: z.literal("role"),
      role: WikiKnownRoleSchema,
      where: z.string().min(1).max(200),
      tech: z.string().min(1).max(120),
    }),
    /** A database, cache or broker the code uses, deployed here or not. */
    z.object({
      ...factBase,
      kind: z.literal("store"),
      name: z.string().min(1).max(120),
      role: z.enum(["database", "cache", "queue"]),
      engine: z.string().max(60).optional(),
      /** The unit that runs it, when this repo deploys it. */
      unit: z.string().min(1).max(120).optional(),
    }),
    z.object({ ...factBase, kind: z.literal("entry"), entry: WikiEntrySchema }),
    /** An address the code calls: a host and port found in a URL, with the call sites as sources. */
    z.object({
      ...factBase,
      kind: z.literal("endpoint"),
      host: z.string().min(1).max(200),
      port: z.number().int().positive().max(65535).optional(),
      /** A local address belongs to the project that wrote it. */
      scope: IdSchema.optional(),
      /** The project a compose file proves owns this host name. */
      known: IdSchema.optional(),
      /** The names of the settings the address was written in. Never their values. */
      keys: z.array(z.string().min(1).max(120)).max(12).default([]),
    }),
    /**
     * One HTTP call a client makes: the method and the path it asks for, the call site as the source. A path is
     * absolute (`/api/v1/items/{}`), without its query, and a part the code fills in at run time is `{}`. Never a
     * header, a body or a value of a setting: the call carries no more than a route does.
     */
    z.object({
      ...factBase,
      kind: z.literal("call"),
      method: z.enum(WIKI_HTTP_METHODS),
      path: CallPathSchema,
      /** The address the call names, when the code writes one in the call itself. Absent: the base is set elsewhere. */
      host: z.string().min(1).max(200).optional(),
      port: z.number().int().positive().max(65535).optional(),
    }),
    /** One part of the system calls another. A `link` with basis `owner` is the owner's answer. */
    z.object({
      ...factBase,
      kind: z.literal("link"),
      from: WikiFactIdSchema,
      to: WikiFactIdSchema,
      type: WikiLinkTypeSchema,
    }),
    z.object({
      ...factBase,
      kind: z.literal("component"),
      name: z.string().min(1).max(120),
      folder: RepoPathSchema,
      role: WikiRoleSchema.default("unknown"),
      files: z.number().int().nonnegative(),
    }),
    /** One step of a flow skeleton, walked from an entry point until a boundary. */
    z.object({
      ...factBase,
      kind: z.literal("step"),
      entry: WikiFactIdSchema,
      index: z.number().int().nonnegative(),
      symbol: z.string().min(1).max(200),
      boundary: z.enum(WIKI_BOUNDARIES).optional(),
    }),
  ])
  .superRefine((fact, ctx) => {
    if (!fact.id.startsWith(`${fact.repo}:${fact.kind}:`)) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: `The id of a ${fact.kind} fact of ${fact.repo} starts with ${fact.repo}:${fact.kind}:`,
      });
    }
    fact.sources.forEach((s, i) => {
      if (s.repo !== fact.repo) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", i, "repo"],
          message: "A source belongs to the repo of its fact",
        });
      }
    });
  });
export type WikiFact = z.infer<typeof WikiFactSchema>;
export type WikiFactOf<K extends WikiFactKind> = Extract<WikiFact, { kind: K }>;

/**
 * What the sealed reader finds, as a number. Raised when the reader learns to find a new kind of fact (2: HTTP calls with
 * their method and path), so a repo already read at its commit is read again, with no model, and no page is rewritten.
 */
export const FACTS_READER = 2;

/** What one fact run of a repo leaves in `facts.json`. */
export const WikiFactsFileSchema = z.object({
  repo: IdSchema,
  commit: CommitShaSchema,
  rules: z.number().int(),
  /** The `FACTS_READER` it was read by. A file from before the number existed is reader 1. */
  reader: z.number().int().default(1),
  facts: z.array(WikiFactSchema).max(50_000),
});
export type WikiFactsFile = z.infer<typeof WikiFactsFileSchema>;

/** What the owner says an address is: one of the workspace's projects, an outside service, or not a call to show. */
export const OwnerAnswerTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), project: IdSchema }),
  z.object({ kind: z.literal("outside") }),
  z.object({ kind: z.literal("ignore") }),
]);
export type OwnerAnswerTarget = z.infer<typeof OwnerAnswerTargetSchema>;

/** One answer of the owner about an address, kept for the workspace: every later update applies it. */
export const OwnerAnswerSchema = z.object({
  host: z.string().min(1).max(200),
  port: z.number().int().positive().max(65535).optional(),
  scope: IdSchema.optional(),
  to: OwnerAnswerTargetSchema,
});
export type OwnerAnswer = z.infer<typeof OwnerAnswerSchema>;

/** An answer about one call a repo makes: its method and path, which survive a change of line. */
export const OwnerCallAnswerSchema = z.object({
  repo: IdSchema,
  method: z.enum(WIKI_HTTP_METHODS),
  path: CallPathSchema,
  to: OwnerAnswerTargetSchema,
});
export type OwnerCallAnswer = z.infer<typeof OwnerCallAnswerSchema>;

/** What the owner can say about a role the wiki guessed: yes it is that, or it is this one instead. */
export const RoleChoiceSchema = z.union([z.literal("confirm"), WikiKnownRoleSchema]);
export type RoleChoice = z.infer<typeof RoleChoiceSchema>;

/** The owner's decision about one role tile of a project's overview. `role` and `where` name the tile as the writer gave it. */
export const OwnerRoleAnswerSchema = z.object({
  project: IdSchema,
  role: WikiKnownRoleSchema,
  where: z.string().min(1).max(200),
  choice: RoleChoiceSchema,
});
export type OwnerRoleAnswer = z.infer<typeof OwnerRoleAnswerSchema>;

/** Everything the owner told the wiki of a workspace, as stored. */
export const WikiAnswerSchema = z.discriminatedUnion("kind", [
  OwnerAnswerSchema.extend({ kind: z.literal("address") }),
  OwnerCallAnswerSchema.extend({ kind: z.literal("call") }),
  OwnerRoleAnswerSchema.extend({ kind: z.literal("role") }),
]);
export type WikiAnswer = z.infer<typeof WikiAnswerSchema>;

// Links between a workspace's projects: made from the facts, never by the model ---------------

/** One side of a link: the project, the fact that shows it and the lines. A declared link has no lines. */
export const WikiLinkEndSchema = z.object({
  project: IdSchema,
  fact: WikiFactIdSchema.optional(),
  sources: z.array(WikiSourceSchema).max(12),
});
export type WikiLinkEnd = z.infer<typeof WikiLinkEndSchema>;

/**
 * A line between two projects of one workspace, with the evidence of both sides and how it is known (strongest
 * first: declared, exact, config, owner). `label` names what it is, like `POST /api/v1/login`.
 */
export const WikiSystemLinkSchema = z.object({
  id: z.string().min(1).max(400),
  type: WikiLinkTypeSchema,
  basis: WikiFactBasisSchema,
  from: WikiLinkEndSchema,
  to: WikiLinkEndSchema,
  label: z.string().min(1).max(200),
});
export type WikiSystemLink = z.infer<typeof WikiSystemLinkSchema>;

/** A call that links to no other project, with where it is and why. */
export const WikiUnlinkedCallSchema = z.object({
  call: WikiFactIdSchema,
  project: IdSchema,
  method: z.enum(WIKI_HTTP_METHODS),
  path: CallPathSchema,
  source: WikiSourceSchema,
  /** `no-route`: no route of another project has it. `ambiguous`: more than one has. */
  why: z.enum(["no-route", "ambiguous"]),
  /** The projects whose routes it matched, when it is ambiguous. */
  matches: z.array(IdSchema).max(20).default([]),
});
export type WikiUnlinkedCall = z.infer<typeof WikiUnlinkedCallSchema>;

/** An address no compose file, no environment URL and no answer places. The owner says what it is. */
export const WikiQuestionSchema = z.object({
  host: z.string().min(1).max(200),
  port: z.number().int().positive().max(65535).optional(),
  scope: IdSchema.optional(),
  /** The projects that call it, and the names of the settings it was written in. */
  projects: z.array(IdSchema).max(40),
  keys: z.array(z.string().min(1).max(120)).max(24),
  sources: z.array(WikiSourceSchema).max(12),
});
export type WikiQuestion = z.infer<typeof WikiQuestionSchema>;

/** What the workspace's facts say about how its projects connect. */
export const WikiSystemViewSchema = z.object({
  org: IdSchema,
  links: z.array(WikiSystemLinkSchema).max(2000),
  unlinked: z.array(WikiUnlinkedCallSchema).max(2000),
  questions: z.array(WikiQuestionSchema).max(500),
  /** Projects with no facts yet, so no link to or from them can show. */
  missing: z.array(IdSchema).max(200),
});
export type WikiSystemView = z.infer<typeof WikiSystemViewSchema>;

/** What the owner asks `wiki.answer` about: an address, or one call (by the id of its fact). */
export const WikiQuestionRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("address"),
    host: z.string().min(1).max(200),
    port: z.number().int().positive().max(65535).optional(),
    scope: IdSchema.optional(),
  }),
  z.object({ kind: z.literal("call"), call: WikiFactIdSchema }),
]);
export type WikiQuestionRef = z.infer<typeof WikiQuestionRefSchema>;

export const WikiAnswerInputSchema = z.object({
  org: IdSchema,
  question: WikiQuestionRefSchema,
  /** One of the workspace's projects, outside, or ignore. `null` forgets an answer given before. */
  to: OwnerAnswerTargetSchema.nullable(),
});
export type WikiAnswerInput = z.infer<typeof WikiAnswerInputSchema>;

export const WikiSetRoleInputSchema = z.object({
  org: IdSchema,
  project: IdSchema,
  role: WikiKnownRoleSchema,
  where: z.string().min(1).max(200),
  /** `confirm` keeps the role and marks it the owner's; a role replaces it; `undo` removes the choice. */
  choice: z.union([RoleChoiceSchema, z.literal("undo")]),
});
export type WikiSetRoleInput = z.infer<typeof WikiSetRoleInputSchema>;

// Pages: written from facts, checked against the code ----------------------------------------

/** What every claim has. A claim is one sentence of a page with the proof behind it. */
const claimBase = {
  /** The number the page's text cites it by: `[n]`. Unique in a page. */
  n: z.number().int().positive(),
  text: z.string().min(1).max(800),
  /** The facts it rests on, when it rests on any. */
  facts: z.array(WikiFactIdSchema).max(20).default([]),
};

/** A claim is proven with at least one source, or guessed with any. A proven claim without a source cannot exist; a guess is drawn dashed and labelled guessed. */
export const WikiClaimSchema = z.discriminatedUnion("proven", [
  z.object({
    ...claimBase,
    proven: z.literal(true),
    sources: z.array(WikiSourceSchema).min(1).max(12),
  }),
  z.object({
    ...claimBase,
    proven: z.literal(false),
    sources: z.array(WikiSourceSchema).max(12),
  }),
]);
export type WikiClaim = z.infer<typeof WikiClaimSchema>;

export const WIKI_DROP_REASONS = [
  "missing-file",
  "bad-range",
  "text-changed",
  "outside-export",
  "no-source",
] as const;
export const WikiDropReasonSchema = z.enum(WIKI_DROP_REASONS);
export type WikiDropReason = z.infer<typeof WikiDropReasonSchema>;

/** A claim the checker could not confirm. It leaves the page and is listed under "Could not confirm" on the Gaps page. */
export const WikiDroppedClaimSchema = z.object({
  text: z.string().min(1).max(800),
  reason: WikiDropReasonSchema,
  cited: z.array(WikiCitationSchema).max(12),
});
export type WikiDroppedClaim = z.infer<typeof WikiDroppedClaimSchema>;

/** One tile of an overview's "Where things are": the role, where it lives, its technology, and the claim that proves it. */
export const WikiRoleRowSchema = z.object({
  role: WikiKnownRoleSchema,
  where: z.string().min(1).max(200),
  tech: z.string().min(1).max(120),
  claim: z.number().int().positive(),
  /** The component page that covers this role, when the plan has one. The tile opens it; without it the tile opens its proof. */
  page: WikiPageIdSchema.refine((id) => wikiPageKind(id) === "component", "Use a component page").optional(),
  /** `owner`: the owner confirmed this role or changed it, so it stands as proven whatever the claim says. */
  basis: z.literal("owner").optional(),
});
export type WikiRoleRow = z.infer<typeof WikiRoleRowSchema>;

/** Pages with no project belong to the workspace: how its repos connect. */
const WORKSPACE_PAGE_KINDS: readonly WikiPageKind[] = ["overview", "flow", "gaps"];

/** The headings of the Gaps page's body that the page also shows as lists of its own data. */
export const WIKI_GAPS_HEADINGS = {
  couldNotConfirm: "Could not confirm",
  guessed: "Guessed",
  guessedRoles: "Guessed roles",
  notLinked: "Not linked calls",
  questions: "Questions for you",
} as const;

export const WikiPageSchema = z
  .object({
    id: WikiPageIdSchema,
    org: IdSchema,
    /** Absent: a workspace page. */
    project: IdSchema.optional(),
    kind: WikiPageKindSchema,
    title: z.string().trim().min(1).max(120),
    /** Markdown. A citation is `[n]`, the `n` of one of `claims`. */
    body: z.string().max(60_000),
    /** On a flow page the claims, in order, are its numbered steps. */
    claims: z.array(WikiClaimSchema).max(400),
    /** Overview pages only: the role tiles. A role not found has no row; the page says "not found". */
    roles: z.array(WikiRoleRowSchema).max(40).default([]),
    dropped: z.array(WikiDroppedClaimSchema).max(400).default([]),
    diagrams: z.array(DiagramSpecSchema).max(6).default([]),
    /** The commit of each repo the page was written from. A project page names its project only. */
    builtFrom: z.record(IdSchema, CommitShaSchema),
    /** The `WIKI_RULES` the page was written by. */
    v: z.number().int().nonnegative(),
  })
  .superRefine((page, ctx) => {
    if (wikiPageKind(page.id) !== page.kind) {
      ctx.addIssue({ code: "custom", path: ["id"], message: `The id ${page.id} is not a ${page.kind} page` });
    }
    const built = Object.keys(page.builtFrom);
    if (page.project === undefined) {
      if (!WORKSPACE_PAGE_KINDS.includes(page.kind)) {
        ctx.addIssue({ code: "custom", path: ["kind"], message: `A workspace has no ${page.kind} page` });
      }
      if (built.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["builtFrom"],
          message: "Name the commit of at least one repo",
        });
      }
    } else if (built.length !== 1 || built[0] !== page.project) {
      ctx.addIssue({
        code: "custom",
        path: ["builtFrom"],
        message: "A project page is built from its own project only",
      });
    }
    const numbers = new Set<number>();
    page.claims.forEach((c, i) => {
      if (numbers.has(c.n)) {
        ctx.addIssue({ code: "custom", path: ["claims", i, "n"], message: `Claim ${c.n} appears twice` });
      }
      numbers.add(c.n);
    });
    if (page.kind !== "overview" && page.roles.length > 0) {
      ctx.addIssue({ code: "custom", path: ["roles"], message: "Only an overview page has role tiles" });
    }
    page.roles.forEach((r, i) => {
      if (!numbers.has(r.claim)) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", i, "claim"],
          message: `No claim ${r.claim} on this page`,
        });
      }
    });
  });
export type WikiPage = z.infer<typeof WikiPageSchema>;

// Status, estimate, commands -------------------------------------------------------------

export const WIKI_PHASES = ["facts", "plan", "write", "check", "store"] as const;
export const WikiPhaseSchema = z.enum(WIKI_PHASES);
export type WikiPhase = z.infer<typeof WikiPhaseSchema>;

const statusBase = {
  org: IdSchema,
  project: IdSchema,
  /** The commit the pages were built from. Absent: never built. */
  builtCommit: CommitShaSchema.optional(),
  /** When the last update stored its pages. */
  builtAt: z.string().optional(),
  /** Commits the base branch has past the built one. Absent: not built, or not counted. */
  behind: z.number().int().nonnegative().optional(),
  /** Files that changed between the built commit and the base tip. A page that cites one may be out of date. */
  changed: z.array(RepoPathSchema).max(5000).default([]),
  /** The pages were written by older rules and the next update rewrites them. */
  oldRules: z.boolean().default(false),
  lastError: z.string().max(500).optional(),
};

/** One project's wiki state. A run in progress says which phase it is in; an idle one says nothing about a phase. */
export const WikiStatusSchema = z.discriminatedUnion("running", [
  z.object({ ...statusBase, running: z.literal(false) }),
  z.object({
    ...statusBase,
    running: z.literal(true),
    phase: WikiPhaseSchema,
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
]);
export type WikiStatus = z.infer<typeof WikiStatusSchema>;

/** What the next update would read and cost. */
export const WikiEstimateSchema = z.object({
  projects: z.number().int().nonnegative(),
  /** Pages that would be rewritten: the ones whose cited files changed. */
  pages: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** Dollars, from the price table. Absent when the model has no price. */
  usd: z.number().nonnegative().optional(),
  /** The most one update spends. */
  cap: z.number().nonnegative(),
  /** The estimate is over the cap: the update would stop early. */
  overCap: z.boolean(),
  /** Why there is nothing to run: no writer model, no projects, nothing changed. */
  note: z.string().optional(),
});
export type WikiEstimate = z.infer<typeof WikiEstimateSchema>;

export const WikiPageSummarySchema = z.object({
  id: WikiPageIdSchema,
  kind: WikiPageKindSchema,
  title: z.string(),
  project: IdSchema.optional(),
  updatedAt: z.string(),
});
export type WikiPageSummary = z.infer<typeof WikiPageSummarySchema>;

/** One scope of a workspace's wiki: a project, or the workspace itself when `project` is absent. */
export const WikiScopeInputSchema = z.object({ org: IdSchema, project: IdSchema.optional() });
export type WikiScopeInput = z.infer<typeof WikiScopeInputSchema>;

export const WikiViewSchema = z.object({
  org: IdSchema,
  project: IdSchema.optional(),
  /** False: the wiki is off for this workspace and nothing else is filled. */
  enabled: z.boolean(),
  pages: z.array(WikiPageSummarySchema),
  /** The project's state, or every project's when the scope is the workspace. */
  status: z.array(WikiStatusSchema),
});
export type WikiView = z.infer<typeof WikiViewSchema>;

/**
 * `replan` picks the flows again instead of keeping the ones chosen at the first build. `page` writes only that page
 * (of `project`, or of the workspace when there is none), with the same caps and the same checks.
 */
export const WikiUpdateInputSchema = WikiScopeInputSchema.extend({
  replan: z.boolean().optional(),
  page: WikiPageIdSchema.optional(),
});
export type WikiUpdateInput = z.infer<typeof WikiUpdateInputSchema>;

export const WikiEstimateInputSchema = WikiScopeInputSchema.extend({ page: WikiPageIdSchema.optional() });
export type WikiEstimateInput = z.infer<typeof WikiEstimateInputSchema>;

export const WikiPageInputSchema = WikiScopeInputSchema.extend({ id: WikiPageIdSchema });
export const WikiPageViewSchema = z.object({
  page: WikiPageSchema,
  updatedAt: z.string(),
  /** Older versions kept in history. */
  versions: z.number().int().nonnegative(),
});
export type WikiPageView = z.infer<typeof WikiPageViewSchema>;

/** A question for the wiki. Without `project` it is asked of the whole workspace: every project's pages and the workspace's own. */
export const WikiAskInputSchema = WikiScopeInputSchema.extend({
  question: z.string().trim().min(1).max(500),
});
export type WikiAskInput = z.infer<typeof WikiAskInputSchema>;

/** A short answer built from the wiki's pages. `found` is false, and `sources` and `pages` are empty, when the wiki does not answer it. */
export const WikiAskOutputSchema = z.object({
  answer: z.string().max(2000),
  /** Where the claims behind the answer are shown in the code. */
  sources: z.array(WikiSourceSchema).max(12),
  /** The pages the answer came from. No `project`: a workspace page. */
  pages: z.array(z.object({ project: IdSchema.optional(), id: WikiPageIdSchema })).max(12),
  found: z.boolean(),
});
export type WikiAskOutput = z.infer<typeof WikiAskOutputSchema>;

/**
 * Whether a workspace has a project wiki: its own setting, else majhi's, else off. Any level can turn it
 * on or back off for what is below it.
 */
export function resolveWikiEnabled(levels: {
  org?: WikiOrgPatch | undefined;
  global?: Pick<WikiPatch, "enabled"> | undefined;
}): boolean {
  return levels.org?.enabled ?? levels.global?.enabled ?? false;
}

// The agent tool --------------------------------------------------------------------------

export const WIKI_TOOL_ACTIONS = ["list", "read", "search", "sources"] as const;

/**
 * What an agent sends the `wiki` tool of `majhi-memory`. The workspace is the task's, never an argument: `project` only
 * picks one of that workspace's projects, and may be left out when the workspace has one wiki.
 */
export const WikiToolInputSchema = z.object({
  action: z
    .enum(WIKI_TOOL_ACTIONS)
    .describe(
      "list: the wiki's pages. read: one page, with its claims and where each is shown. search: the pieces of the pages that best match words. sources: where a claim is shown in the code.",
    ),
  project: IdSchema.optional().describe(
    "One of this workspace's projects. Leave out when there is one wiki.",
  ),
  workspace: z
    .boolean()
    .optional()
    .describe(
      "true: the workspace's own pages (how its projects connect, the cross-repo flows, the gaps) instead of one project's. For read and search.",
    ),
  page: z
    .string()
    .max(80)
    .optional()
    .describe("For read: a page id from list, like overview or flow:sign-in."),
  words: z.string().min(2).max(300).optional().describe("For search: the words to look for."),
  claim: z
    .string()
    .min(2)
    .max(300)
    .optional()
    .describe("For sources: the words of the claim, as on the page."),
});
export type WikiToolInput = z.infer<typeof WikiToolInputSchema>;

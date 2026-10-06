import { type DiagramSpec, DiagramSpecSchema, type WikiClaim, type WikiPageKind } from "@majhi/shared";
import type { DraftDiagram, DraftPage } from "./draft.ts";

/** A claim that passed the check, with the place it had in the draft. */
export interface KeptClaim {
  /** Index into the draft's claims. */
  at: number;
  claim: WikiClaim;
}

const HEADING: Record<Exclude<WikiPageKind, "gaps">, string> = {
  overview: "Also worth knowing",
  infra: "What runs where",
  component: "In detail",
  flow: "Steps",
};

/** One claim as a line of the page. A guess says so, for readers of the plain text. */
function line(c: WikiClaim): string {
  return `${c.text} [${c.n}]${c.proven ? "" : " (guessed)"}`;
}

/**
 * The page as markdown: the opening sentences, then the claims (a flow's as numbered steps), and on an
 * overview what was not found. The tiles of an overview carry their own claims, so those are not repeated.
 */
export function bodyOf(
  draft: DraftPage,
  kept: readonly KeptClaim[],
  summary: readonly string[],
  tiles: ReadonlySet<number>,
): string {
  const rest = kept.filter((k) => !tiles.has(k.claim.n));
  const parts: string[] = [summary.join(" ")];
  if (rest.length > 0) {
    parts.push(`## ${HEADING[draft.kind]}`);
    parts.push(
      rest
        .map((k, i) => (draft.kind === "flow" ? `${i + 1}. ${line(k.claim)}` : `- ${line(k.claim)}`))
        .join("\n"),
    );
  }
  if (draft.kind === "overview" && draft.couldNot.length > 0) {
    parts.push("## Not found");
    parts.push(draft.couldNot.map((c) => `- ${c.topic}: ${c.why}`).join("\n"));
  }
  return parts.join("\n\n");
}

const slug = (label: string): string => {
  let out = "";
  for (const ch of label.toLowerCase()) {
    const plain = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (plain) out += ch;
    else if (!out.endsWith("-")) out += "-";
  }
  return out.slice(0, 40);
};

/**
 * A flow's sequence diagram: one actor per process, one arrow per step from its actor to the next step's
 * actor. A step that is a guess is dashed. Undefined when a step names no actor or the picture does not fit.
 */
function sequence(draft: DraftPage, kept: readonly KeptClaim[]): DiagramSpec | undefined {
  const steps = kept.map((k) => ({
    claim: k.claim,
    actor: draft.claims[k.at]?.actor,
    label: draft.claims[k.at]?.label,
  }));
  if (steps.length === 0 || steps.some((s) => s.actor === undefined)) return undefined;
  const ids = new Map<string, string>();
  for (const s of steps) {
    const id = slug(s.actor ?? "");
    if (!ids.has(id)) ids.set(id, s.actor ?? id);
  }
  const edges = steps.map((s, i) => ({
    from: slug(s.actor ?? ""),
    to: slug(steps[i + 1]?.actor ?? s.actor ?? ""),
    label: `${s.claim.n}. ${s.label ?? ""}`.trim().slice(0, 60),
    type: "step" as const,
    ...(s.claim.proven ? {} : { style: "dashed" as const }),
  }));
  const parsed = DiagramSpecSchema.safeParse({
    title: draft.title.slice(0, 80),
    layout: "sequence",
    nodes: [...ids].map(([id, label]) => ({ id, label: label.slice(0, 60) })),
    actors: [...ids.keys()],
    edges,
  });
  return parsed.success ? parsed.data : undefined;
}

/** A box-and-lines picture the writer drew. A line is solid when the claim it names was kept and is proven, else dashed. */
function boxes(diagram: DraftDiagram, kept: readonly KeptClaim[]): DiagramSpec | undefined {
  const proven = new Set(kept.filter((k) => k.claim.proven).map((k) => k.at));
  const parsed = DiagramSpecSchema.safeParse({
    title: diagram.title,
    layout: "flow",
    nodes: diagram.nodes,
    edges: diagram.edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.label === undefined ? {} : { label: e.label }),
      ...(e.claim !== undefined && proven.has(e.claim) ? {} : { style: "dashed" as const }),
    })),
  });
  return parsed.success ? parsed.data : undefined;
}

/** The diagrams of a page: a flow's from its steps, any other page's from what the writer drew. A picture that does not parse is left out. */
export function diagramsOf(draft: DraftPage, kept: readonly KeptClaim[]): DiagramSpec[] {
  const spec =
    draft.kind === "flow"
      ? sequence(draft, kept)
      : draft.diagram === undefined
        ? undefined
        : boxes(draft.diagram, kept);
  return spec === undefined ? [] : [spec];
}

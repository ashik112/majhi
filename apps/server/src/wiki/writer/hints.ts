import type { WikiEntry, WikiFact, WikiFactOf } from "@majhi/shared";
import type { WriterPage } from "./draft.ts";

/** At most this many fact lines go into one prompt, and about this many characters. Facts are leads, not the reading. */
export const HINT_LINES = 70;
export const HINT_CHARS = 14_000;
/** The Deploys page reads many files, each in a long line. */
const DEPLOY_HINT_LINES = 90;
const DEPLOY_HINT_CHARS = 28_000;

function entryText(e: WikiEntry): string {
  switch (e.type) {
    case "http":
      return `${e.method} ${e.path}${e.handler === undefined ? "" : ` -> ${e.handler}`}`;
    case "queue":
      return `queue task ${e.name}${e.handler === undefined ? "" : ` -> ${e.handler}`}`;
    case "timer":
      return `timer ${e.schedule}${e.handler === undefined ? "" : ` -> ${e.handler}`}`;
    case "command":
      return `command ${e.name}${e.handler === undefined ? "" : ` -> ${e.handler}`}`;
    case "socket":
      return `socket ${e.name}${e.handler === undefined ? "" : ` -> ${e.handler}`}`;
  }
}

/** What a fact says, in one short phrase. Never an env value: facts do not hold them. */
export function factText(f: WikiFact): string {
  switch (f.kind) {
    case "unit":
      return `unit ${f.name} (${f.role}${f.runsOn === undefined ? "" : `, ${f.runsOn}`}${f.image === undefined ? "" : `, image ${f.image}`}${f.ports.length === 0 ? "" : `, ports ${f.ports.join(" ")}`}${f.dependsOn.length === 0 ? "" : `, needs ${f.dependsOn.join(" ")}`})`;
    case "role":
      return `${f.role}: ${f.tech} at ${f.where}`;
    case "store":
      return `${f.role} ${f.name}${f.engine === undefined ? "" : ` (${f.engine})`}${f.unit === undefined ? "" : ` run by unit ${f.unit}`}`;
    case "entry":
      return entryText(f.entry);
    case "endpoint":
      return `address ${f.host}${f.port === undefined ? "" : `:${f.port}`}${f.keys.length === 0 ? "" : ` set in ${f.keys.join(" ")}`}`;
    case "call":
      return `call ${f.method} ${f.path}${f.host === undefined ? "" : ` on ${f.host}${f.port === undefined ? "" : `:${f.port}`}`}`;
    case "link":
      return `${f.type} link ${f.from} -> ${f.to}`;
    case "component":
      return `component ${f.name} in ${f.folder} (${f.role}, ${f.files} files)`;
    case "step":
      return `step ${f.index} of ${f.entry}: ${f.symbol}${f.boundary === undefined ? "" : ` (reaches ${f.boundary})`}`;
    case "deploy":
      return deployText(f);
  }
}

/** One deploy file in a line: what starts it, its inputs, its jobs (what each needs and where it goes) and its locks. */
function deployText(f: WikiFactOf<"deploy">): string {
  const jobs = f.jobs.map(
    (j) =>
      `${j.name}${j.manual ? " [manual]" : ""}${j.stage === undefined ? "" : ` stage ${j.stage}`}${j.environment === undefined ? "" : ` env ${j.environment}`}${j.needs.length === 0 ? "" : ` needs ${j.needs.join("+")}`}${j.rule === undefined ? "" : ` when ${j.rule}`}${j.inputs.length === 0 ? "" : ` inputs ${j.inputs.join("+")}`}`,
  );
  const parts = [
    f.triggers.length === 0 ? undefined : `starts on ${f.triggers.join(" or ")}`,
    f.inputs.length === 0 ? undefined : `inputs ${f.inputs.join(" ")}`,
    jobs.length === 0 ? undefined : `jobs ${jobs.join(", ")}`,
    f.guards.length === 0 ? undefined : `guards ${f.guards.join(", ")}`,
    f.note,
  ].filter((part) => part !== undefined);
  return `${f.system} ${f.name}${parts.length === 0 ? "" : `: ${parts.join("; ")}`}`;
}

/** One fact as a prompt line: its id, what it says, the first place that shows it, how it is known. */
export function factLine(f: WikiFact): string {
  const at = f.sources[0];
  return `${f.id} | ${factText(f)} | ${at === undefined ? "no source" : `${at.path}:${at.lines[0]}-${at.lines[1]}`} | ${f.basis}`;
}

const BY_KIND: Record<WikiFact["kind"], number> = {
  unit: 0,
  role: 1,
  store: 2,
  component: 3,
  link: 4,
  entry: 5,
  endpoint: 6,
  call: 7,
  step: 8,
  deploy: 9,
};

/** Deploy files, the ones that start a deploy first: pipelines, then what a platform pulls, then the rest. */
const DEPLOY_ORDER: Record<WikiFactOf<"deploy">["system"], number> = {
  "github-actions": 0,
  "gitlab-ci": 1,
  bitbucket: 2,
  gitops: 3,
  platform: 4,
  make: 5,
  script: 6,
  docker: 7,
  doc: 8,
};

/** The facts that are leads for `page`, most useful first. */
export function hintFacts(page: WriterPage, facts: readonly WikiFact[]): WikiFact[] {
  const ranked = (list: readonly WikiFact[]) => [...list].sort((a, b) => BY_KIND[a.kind] - BY_KIND[b.kind]);
  switch (page.kind) {
    case "overview":
      return ranked(
        facts.filter(
          (f) => f.kind !== "step" && f.kind !== "endpoint" && f.kind !== "call" && f.kind !== "deploy",
        ),
      );
    case "deploys":
      // The deploy files first, then the units they put somewhere.
      return facts
        .filter((f) => f.kind === "deploy" || f.kind === "unit")
        .toSorted((a, b) =>
          a.kind === "deploy" && b.kind === "deploy"
            ? DEPLOY_ORDER[a.system] - DEPLOY_ORDER[b.system]
            : a.kind === b.kind
              ? 0
              : a.kind === "deploy"
                ? -1
                : 1,
        );
    case "infra":
      return ranked(
        facts.filter(
          (f) =>
            f.kind === "unit" ||
            f.kind === "store" ||
            f.kind === "role" ||
            f.kind === "endpoint" ||
            (f.kind === "link" && f.type === "deploy"),
        ),
      );
    case "component": {
      const named = new Set<string>(page.facts);
      const folder = `${page.folder}/`;
      return ranked(
        facts.filter(
          (f) =>
            f.kind !== "deploy" &&
            (named.has(f.id) || f.sources.some((s) => s.path === page.folder || s.path.startsWith(folder))),
        ),
      );
    }
    case "flow": {
      const named = new Set<string>(page.facts);
      // The entries named, the steps walked from them, and the links that touch any of these.
      const touched = new Set<string>([
        ...named,
        ...facts.filter((f) => f.kind === "step" && named.has(f.entry)).map((f) => f.id),
      ]);
      return facts
        .filter((f) => touched.has(f.id) || (f.kind === "link" && (touched.has(f.from) || touched.has(f.to))))
        .sort((a, b) => stepOrder(a) - stepOrder(b));
    }
  }
}

/** Steps in the order they are walked, after the entry they start from. */
function stepOrder(f: WikiFact): number {
  return f.kind === "step" ? 100 + f.index : BY_KIND[f.kind];
}

/** The hint block of a prompt: lines cut to the limits, and a note of how many were left out. */
export function hintBlock(page: WriterPage, facts: readonly WikiFact[]): { text: string; shown: string[] } {
  const all = hintFacts(page, facts);
  const maxLines = page.kind === "deploys" ? DEPLOY_HINT_LINES : HINT_LINES;
  const maxChars = page.kind === "deploys" ? DEPLOY_HINT_CHARS : HINT_CHARS;
  const shown: string[] = [];
  const lines: string[] = [];
  let chars = 0;
  for (const f of all) {
    const line = defang(factLine(f));
    if (lines.length >= maxLines || chars + line.length > maxChars) break;
    lines.push(line);
    shown.push(f.id);
    chars += line.length + 1;
  }
  if (all.length > lines.length) lines.push(`(${all.length - lines.length} more facts not shown)`);
  return { text: lines.length === 0 ? "None found." : lines.join("\n"), shown };
}

/** Text from a repo goes into the prompt inside a fence the text cannot close. */
export function defang(text: string): string {
  return text.split("<").join("(").split("\n").join(" ");
}

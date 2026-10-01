/**
 * The scope eval: where should each fact go, against a labeled set (`scope-eval.json`).
 *
 *   tsx apps/server/src/memory/eval/scope-eval.ts               Laya (if installed) and the rules
 *   tsx apps/server/src/memory/eval/scope-eval.ts --housekeeper  also asks the Housekeeper prompt
 *                                                                 (claude -p, haiku) for cases that
 *                                                                 lack its answer, and saves them
 *
 * Laya runs straight from the venv the host helper installed (~/.majhi/laya). Nothing here touches
 * majhi's database or a running server. It reports, for each source, how many it got right.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryScope, RoomItem } from "@majhi/shared";
import { decider, Laya } from "../../decisions/eval/laya.ts";
import { chatLines, chatPrompt, parseChatReply } from "../housekeeper.ts";
import {
  combine,
  type PlaceContext,
  Placer,
  placeChoices,
  placeWithoutModel,
  type Registry,
} from "../placement.ts";
import { writableScopes } from "../scopes.ts";

interface Case {
  org: string | null;
  touched: string[];
  text: string;
  expected: MemoryScope;
  /** The Housekeeper's scope, saved by `--housekeeper`. Null when it gave none. */
  housekeeper?: MemoryScope | null;
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "scope-eval.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { registry: Registry; cases: Case[] };
const { registry, cases } = fixture;

function context(c: Case, i: number): PlaceContext {
  const projectOrgs = new Map(registry.projects.map((p) => [p.id, p.org]));
  const org = c.org ?? undefined;
  return {
    task: `EVAL-${i + 1}`,
    org,
    touched: c.touched,
    allowed: writableScopes(
      { org },
      projectOrgs,
      registry.orgs.map((o) => o.id),
    ),
  };
}

// ---------------------------------------------------------------------------
// The Housekeeper's own scope, asked once per case and saved

function askHousekeeper(c: Case, i: number): MemoryScope | null {
  const ctx = context(c, i);
  const at = "2026-10-01T00:00:00.000Z";
  const items = [
    { type: "owner", text: c.text, seq: 1, id: "o", task: ctx.task, at, attachments: [], queued: false },
    {
      type: "agent",
      agent: "boss",
      text: "Noted, I will keep that in mind.",
      seq: 2,
      id: "a",
      task: ctx.task,
      at,
    },
  ] as unknown as RoomItem[];
  const prompt = chatPrompt({
    chat: { id: ctx.task, org: ctx.org, projects: c.touched, title: "Chat", agent: "boss" },
    choices: placeChoices(registry, ctx),
    messages: chatLines(items),
  });
  const run = spawnSync("claude", ["-p", "--model", "haiku"], {
    input: prompt,
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 110_000,
  });
  const parsed = parseChatReply(run.stdout ?? "");
  if (!parsed.ok) {
    console.error(`case ${i + 1}: no usable reply (${parsed.problem})`);
    return null;
  }
  // A scope it may not use counts as none, and is never saved: a model can name anything.
  const scope = parsed.value[0]?.scope;
  return scope !== undefined && ctx.allowed.includes(scope) ? scope : null;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes("--housekeeper")) {
    for (const [i, c] of cases.entries()) {
      if (c.housekeeper !== undefined) continue;
      c.housekeeper = askHousekeeper(c, i);
      console.error(`case ${i + 1}: Housekeeper says ${c.housekeeper ?? "nothing"}`);
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    }
  }

  const useLaya = Laya.available();
  const laya = useLaya ? new Laya() : undefined;
  const provider = useLaya ? "laya" : "rules";
  const placer = new Placer({
    decisions: { decide: decider(provider, laya), outcome: () => undefined },
    registry: async () => registry,
  });

  const score = {
    model: 0,
    modelAnswered: 0,
    housekeeper: 0,
    hkAnswered: 0,
    touched: 0,
    noModel: 0,
    override: 0,
    tiebreak: 0,
  };
  const rows: string[] = [];
  for (const [i, c] of cases.entries()) {
    const ctx = context(c, i);
    const proposed = c.housekeeper ?? undefined;
    const pick = await placer.ask(registry, ctx, { text: c.text, proposed });
    const hk = proposed !== undefined && ctx.allowed.includes(proposed) ? proposed : undefined;
    const touched = placeWithoutModel(registry, ctx, { text: c.text }).scope;
    const fact = { text: c.text, proposed };
    const override = (await combine("override", registry, ctx, fact, async () => pick)).scope;
    const tiebreak = (await combine("tiebreak", registry, ctx, fact, async () => pick)).scope;
    if (pick.scope !== undefined) score.modelAnswered += 1;
    if (pick.scope === c.expected) score.model += 1;
    if (hk !== undefined) score.hkAnswered += 1;
    if (hk === c.expected) score.housekeeper += 1;
    if (touched === c.expected) score.touched += 1;
    if (placeWithoutModel(registry, ctx, fact).scope === c.expected) score.noModel += 1;
    if (override === c.expected) score.override += 1;
    if (tiebreak === c.expected) score.tiebreak += 1;
    if (process.argv.includes("--verbose"))
      for (const d of pick.decisions)
        for (const [k, a] of Object.entries(d.answers))
          console.error(
            `${i + 1} ${k}: ${String(a.value)} ${JSON.stringify(a.probabilities)} ${a.gate?.reason ?? ""}`,
          );
    const mark = (s: string | undefined) => `${s ?? "-"}${s === c.expected ? " ok" : ""}`;
    rows.push(
      [
        String(i + 1).padStart(2),
        c.expected.padEnd(22),
        mark(pick.scope).padEnd(25),
        mark(hk).padEnd(25),
        mark(tiebreak).padEnd(25),
        c.text.slice(0, 60),
      ].join(" | "),
    );
  }
  laya?.close();
  const total = cases.length;
  const pct = (k: number, d = total) => `${k}/${d} (${d === 0 ? 0 : Math.round((100 * k) / d)}%)`;
  console.log(rows.join("\n"));
  console.log("");
  console.log(`Provider: ${provider}${useLaya ? "" : " (Laya is not installed here)"}`);
  console.log(
    `${provider} alone: ${pct(score.model)} right; answered ${pct(score.modelAnswered)}, right when it answered ${pct(score.model, score.modelAnswered)}`,
  );
  console.log(`Housekeeper alone: ${pct(score.housekeeper)} right; answered ${pct(score.hkAnswered)}`);
  console.log(`Touched scope alone: ${pct(score.touched)}`);
  console.log(`Housekeeper, then touched, no model: ${pct(score.noModel)}`);
  console.log(`Combined, ${provider} overrides: ${pct(score.override)}`);
  console.log(`Combined, ${provider} breaks ties (shipped): ${pct(score.tiebreak)}`);
}

await main();

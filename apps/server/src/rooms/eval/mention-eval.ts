/**
 * The mention eval: does a message ask the agent it mentions to act now? Against a labeled set
 * (`mention-eval.json`), for the words alone (`statusOnly`), the provider alone, and both as the
 * coordinator uses them (status wakes nobody; else a sure "no" keeps the agent asleep).
 *
 *   tsx apps/server/src/rooms/eval/mention-eval.ts            Laya if installed, else the rules
 *   tsx apps/server/src/rooms/eval/mention-eval.ts --verbose  with each answer's probabilities
 *
 * The number that matters: a "no" on a clear request leaves work undone, so it must be zero
 * before `QUIET_ON_NO` is on.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { decider, Laya } from "../../decisions/eval/laya.ts";
import { statusOnly } from "../coordinate.ts";
import { mentionQuestion, readMentions } from "../mentions.ts";

const CaseSchema = z.object({
  from: z.string(),
  to: z.string(),
  expected: z.enum(["act", "no"]),
  text: z.string(),
});
const here = dirname(fileURLToPath(import.meta.url));
const { cases } = z
  .object({ cases: z.array(CaseSchema) })
  .parse(JSON.parse(readFileSync(join(here, "mention-eval.json"), "utf8")));

type Read = "act" | "no" | "unsure";

async function main(): Promise<void> {
  const useLaya = Laya.available();
  const laya = useLaya ? new Laya() : undefined;
  const provider = useLaya ? "laya" : "rules";
  const decide = decider(provider, laya);
  const verbose = process.argv.includes("--verbose");

  const rows: string[] = [];
  const tally = {
    words: { no: 0, falseNo: 0 },
    model: { act: 0, no: 0, unsure: 0, rightAct: 0, rightNo: 0, falseNo: 0, falseAct: 0 },
    shipped: { right: 0, rightNo: 0, falseNo: 0 },
  };
  for (const [i, c] of cases.entries()) {
    const words = statusOnly(c.text);
    const result = await decide(mentionQuestion(c.from, [c.to], c.text));
    const reading = readMentions([c.to], result);
    const model: Read = reading.act.length > 0 ? "act" : reading.quiet.length > 0 ? "no" : "unsure";
    const shipped: "act" | "no" = words || model === "no" ? "no" : "act";

    if (words) {
      tally.words.no += 1;
      if (c.expected === "act") tally.words.falseNo += 1;
    }
    tally.model[model] += 1;
    if (model === "act" && c.expected === "act") tally.model.rightAct += 1;
    if (model === "no" && c.expected === "no") tally.model.rightNo += 1;
    if (model === "no" && c.expected === "act") tally.model.falseNo += 1;
    if (model === "act" && c.expected === "no") tally.model.falseAct += 1;
    if (shipped === c.expected) tally.shipped.right += 1;
    if (shipped === "no" && c.expected === "no") tally.shipped.rightNo += 1;
    if (shipped === "no" && c.expected === "act") tally.shipped.falseNo += 1;

    const answer = Object.values(result.answers)[0];
    if (verbose)
      console.error(
        `${i + 1} ${String(answer?.value)} ${JSON.stringify(answer?.probabilities)} ${answer?.gate?.reason ?? ""}`,
      );
    rows.push(
      [
        String(i + 1).padStart(2),
        c.expected.padEnd(3),
        (words ? "status" : "-").padEnd(6),
        model.padEnd(6),
        `${shipped}${shipped === c.expected ? " ok" : " WRONG"}`.padEnd(9),
        c.text.slice(0, 70),
      ].join(" | "),
    );
  }
  laya?.close();

  const total = cases.length;
  const acts = cases.filter((c) => c.expected === "act").length;
  const nos = total - acts;
  const pct = (k: number, d: number) => `${k}/${d} (${d === 0 ? 0 : Math.round((100 * k) / d)}%)`;
  console.log(" # | exp | words  | model  | shipped   | message");
  console.log(rows.join("\n"));
  console.log("");
  console.log(`Provider: ${provider}${useLaya ? "" : " (Laya is not installed here)"}`);
  console.log(`Cases: ${total}, ${acts} asking to act, ${nos} not`);
  console.log(
    `Words alone (statusOnly): caught ${pct(tally.words.no - tally.words.falseNo, nos)} of the no cases; false no on requests: ${tally.words.falseNo}`,
  );
  const m = tally.model;
  console.log(
    `${provider} alone: sure yes ${m.act}, sure no ${m.no}, unsure ${m.unsure}; right yes ${pct(m.rightAct, acts)}, right no ${pct(m.rightNo, nos)}; false no on requests: ${m.falseNo}; false yes: ${m.falseAct}`,
  );
  console.log(
    `Shipped (words, then a sure no): right ${pct(tally.shipped.right, total)}, no cases kept asleep ${pct(tally.shipped.rightNo, nos)}, false no on requests: ${tally.shipped.falseNo}`,
  );
}

await main();

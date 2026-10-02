import { askedOptions, type DecisionRecord, type ProviderId } from "@majhi/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useCorrectDecision, useRecentDecisions } from "@/lib/decisions-queries";
import { describeError } from "@/lib/errors";

const PAGE = 10;

const NAME: Record<ProviderId, string> = {
  laya: "Laya",
  jev: "Jev",
  acp: "Stand-in agent",
  rules: "Rules",
};

const USE: Record<DecisionRecord["use"], string> = {
  "model-pick": "Model pick",
  routing: "Room",
  tool: "Agent tool",
  owner: "Asked here",
  memory: "Memory",
  "task-size": "Task size",
};

/** What the owner can name as right: what the code that asked listed, else the question's options. */
function choicesOf(d: DecisionRecord): string[] {
  if (d.outcome?.choices !== undefined) return d.outcome.choices;
  return Object.values(d.request?.questions ?? {}).flatMap((q) =>
    q.type === "choice"
      ? askedOptions(q).map((o) => o.key)
      : q.type === "noul"
        ? ["true", "false"]
        : Array.from({ length: q.max - q.min + 1 }, (_, i) => String(q.min + i)),
  );
}

/** The recent decisions, a page at a time, with what each did and a way to say it was wrong. */
export function RecentDecisions() {
  const [offset, setOffset] = useState(0);
  const recent = useRecentDecisions(PAGE, offset);
  const records = recent.data?.records ?? [];
  const none = offset === 0 && recent.data !== undefined && records.length === 0;
  return (
    <DetailSection
      title="Recent decisions"
      note="What each pick did. Wrong pick keeps the right answer for learning."
      actions={
        !none && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Newer
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={recent.data?.more !== true}
              onClick={() => setOffset(offset + PAGE)}
            >
              Older
            </Button>
          </>
        )
      }
    >
      {none && <p className="text-sm text-fg-faint">No decisions yet.</p>}
      {recent.isError && <p className="m-0 text-sm text-red">{describeError(recent.error)}</p>}
      {!none && (
        <ul aria-label="Recent decisions" className="m-0 flex max-w-[860px] list-none flex-col p-0">
          {records.map((d) => (
            <DecisionRow key={d.id} d={d} />
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

function DecisionRow({ d }: { d: DecisionRecord }) {
  const [open, setOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const answers = Object.entries(d.answers);
  const counted = answers.every(([, a]) => a.gate?.accepted !== false);
  return (
    <li className="flex flex-col gap-1 border-t border-line py-2 text-sm first:border-t-0">
      {/* Line 1: what was decided, by whom, and the actions. Line 2: the answer, full width. */}
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-fg-muted">{USE[d.use]}</span>
        <span className="shrink-0 text-xs text-fg-faint">{NAME[d.provider]}</span>
        {!counted && <Badge tone="amber">Fell back</Badge>}
        {d.correction !== undefined && <Badge tone="blue">Corrected</Badge>}
        <span className="flex-1" />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="shrink-0 cursor-pointer rounded-xs text-xs text-fg-muted hover:text-fg"
        >
          {open ? "Hide" : "Details"}
        </button>
        <button
          type="button"
          onClick={() => setCorrecting(!correcting)}
          className="shrink-0 cursor-pointer rounded-xs text-xs text-fg-muted hover:text-fg"
        >
          Wrong pick
        </button>
      </div>
      <span className="font-mono text-xs [overflow-wrap:anywhere] text-fg">
        {answers
          .map(
            ([k, a]) =>
              `${k}=${String(a.value)} ${(a.probabilities?.[String(a.value)] ?? a.confidence).toFixed(2)}`,
          )
          .join(" · ")}
      </span>
      {d.outcome !== undefined && <p className="m-0 text-fg-muted">{d.outcome.text}</p>}
      {d.correction !== undefined && (
        <p className="m-0 text-fg-muted">
          Right answer: <strong className="text-fg">{d.correction.right}</strong>
          {d.correction.note === undefined ? "" : `. ${d.correction.note}`}
        </p>
      )}
      {correcting && <CorrectForm d={d} done={() => setCorrecting(false)} />}
      {open && <Details d={d} />}
    </li>
  );
}

function CorrectForm({ d, done }: { d: DecisionRecord; done: () => void }) {
  const toast = useToast();
  const correct = useCorrectDecision();
  const choices = choicesOf(d);
  const [right, setRight] = useState(d.correction?.right ?? choices[0] ?? "");
  const [note, setNote] = useState(d.correction?.note ?? "");
  return (
    <form
      aria-label="Wrong pick"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (right.trim() === "") return;
        correct.mutate(
          { id: d.id, right, ...(note.trim() === "" ? {} : { note }) },
          {
            onSuccess: () => {
              toast("Saved. It is kept for learning and changes nothing now.");
              done();
            },
            onError: (e) => toast("Could not save", { detail: describeError(e), tone: "error" }),
          },
        );
      }}
    >
      <span className="text-fg-muted">What was right?</span>
      {choices.length > 0 ? (
        <Select aria-label="Right answer" value={right} onChange={(e) => setRight(e.target.value)}>
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      ) : (
        <Input aria-label="Right answer" value={right} onChange={(e) => setRight(e.target.value)} />
      )}
      <Input
        aria-label="Note"
        placeholder="Note (optional)"
        className="min-w-[180px] flex-1"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button type="submit" size="sm" variant="primary" disabled={correct.isPending || right.trim() === ""}>
        Save
      </Button>
    </form>
  );
}

function Details({ d }: { d: DecisionRecord }) {
  const state = d.request?.state;
  return (
    <div className="flex flex-col gap-1 text-fg-muted">
      <p className="m-0">
        {new Date(d.at).toLocaleString()} · {d.durationMs} ms
        {d.version === undefined ? "" : ` · ${d.version}`}
        {d.trimmed === true ? " · the state was cut to fit" : ""}
        {d.estimated ? " · estimated" : ""}
      </p>
      {d.skipped !== undefined && d.skipped.length > 0 && (
        <p className="m-0">Skipped: {d.skipped.map((s) => `${NAME[s.provider]} (${s.reason})`).join("; ")}</p>
      )}
      {Object.entries(d.answers).map(([k, a]) => (
        <div key={k}>
          <p className="m-0">
            <span className="font-mono text-fg">{k}</span>: {d.request?.questions[k]?.instructions ?? ""}
            {a.gate === undefined
              ? ""
              : ` ${a.gate.accepted ? "Counted" : "Did not count"}: ${a.gate.reason}.`}
          </p>
          {a.probabilities !== undefined && (
            <p className="m-0 font-mono">
              {Object.entries(a.probabilities)
                .map(([o, p]) => `${o} ${p.toFixed(2)}`)
                .join("  ")}
              {a.runs === undefined ? "" : `  (${a.runs.length} orders, averaged)`}
            </p>
          )}
        </div>
      ))}
      {state !== undefined && (
        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-sunken p-1.5 font-mono text-xs">
          {typeof state === "string" ? state : JSON.stringify(state, null, 2)}
        </pre>
      )}
    </div>
  );
}

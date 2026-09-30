import type { MemorySettings } from "@majhi/shared";
import { useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSaveSettings } from "@/lib/boss-queries";
import { useAccountModels, useAgents } from "@/lib/studio-queries";

export const THRESHOLD_MIN = 0.2;

/** The threshold field's text as a number from 0.2 to 1, or undefined when it is not one. */
export function parseThreshold(text: string): number | undefined {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(value) && value >= THRESHOLD_MIN && value <= 1
    ? value
    : undefined;
}

const IDLE: SaveState = { kind: "idle" };

interface Edits {
  threshold?: string;
  reviewAll?: boolean;
  housekeeper?: string;
  model?: string;
}

/**
 * Memory curation: who reads a finished task's room, how sure curation must be to act alone, and
 * reviewing everything. Only the fields changed here are drafts; the rest follow the saved settings.
 */
export function MemorySection({ saved }: { saved: MemorySettings }) {
  const save = useSaveSettings();
  const agents = useAgents();
  const [edits, setEdits] = useState<Edits>({});
  const [state, setState] = useState<SaveState>(IDLE);
  const [showErrors, setShowErrors] = useState(false);
  const threshold = edits.threshold ?? String(saved.auto_threshold);
  const reviewAll = edits.reviewAll ?? saved.review_all;
  const housekeeper = edits.housekeeper ?? saved.housekeeper ?? "";
  const model = edits.model ?? saved.housekeeper_model ?? "";
  const edit = (patch: Edits) => {
    if (state.kind !== "saving") setState(IDLE);
    setEdits((e) => ({ ...e, ...patch }));
  };

  const ok = (agents.data ?? []).flatMap((a) => (a.status === "ok" ? [a] : []));
  const boss = ok.find((a) => a.isBoss)?.agent.frontmatter;
  const chosen =
    housekeeper === "" ? boss : ok.find((a) => a.agent.frontmatter.id === housekeeper)?.agent.frontmatter;
  const models = useAccountModels(chosen?.account);
  const offered = models.data?.models ?? [];

  const parsed = parseThreshold(threshold);
  const error = parsed === undefined ? `Use a number from ${THRESHOLD_MIN} to 1.` : undefined;
  const dirty =
    parsed !== saved.auto_threshold ||
    reviewAll !== saved.review_all ||
    housekeeper !== (saved.housekeeper ?? "") ||
    model !== (saved.housekeeper_model ?? "");

  function onSave() {
    setShowErrors(true);
    if (parsed === undefined || !dirty) return;
    setState({ kind: "saving" });
    save.mutate(
      {
        memory: {
          ...(parsed !== saved.auto_threshold ? { auto_threshold: parsed } : {}),
          ...(reviewAll !== saved.review_all ? { review_all: reviewAll } : {}),
          ...(housekeeper !== (saved.housekeeper ?? "")
            ? { housekeeper: housekeeper === "" ? null : housekeeper }
            : {}),
          ...(model !== (saved.housekeeper_model ?? "")
            ? { housekeeper_model: model === "" ? null : model }
            : {}),
        },
      },
      {
        onSuccess: () => {
          setEdits({});
          setShowErrors(false);
          setState({ kind: "saved" });
        },
        onError: (e) => setState({ kind: "error", message: e.message, details: e.details }),
      },
    );
  }

  return (
    <SaveSection
      title="Memory curation"
      note="Saved to majhi.yaml, as a change you can undo"
      className="border-t-0"
      dirty={dirty}
      state={state}
      onSave={onSave}
      onDiscard={() => {
        setEdits({});
        setShowErrors(false);
        setState(IDLE);
      }}
    >
      <form
        aria-label="Memory settings"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
        className="flex max-w-[640px] flex-col gap-4"
      >
        <div className="grid gap-3 @[480px]:grid-cols-2">
          <Field
            label="Housekeeper"
            hint="Reads each finished task and writes its record, the project brief and any lessons. The only memory step that spends tokens."
          >
            {(p) => (
              <Select
                {...p}
                value={housekeeper}
                onChange={(e) => edit({ housekeeper: e.target.value, model: "" })}
              >
                <option value="">{boss ? `Boss (@${boss.id})` : "Boss (none chosen yet)"}</option>
                {ok.map((a) => (
                  <option key={a.agent.frontmatter.id} value={a.agent.frontmatter.id}>
                    @{a.agent.frontmatter.id} ({a.agent.frontmatter.role})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Housekeeper model"
            hint={
              chosen === undefined
                ? "Choose the boss or a Housekeeper first."
                : `From ${chosen.account}. Cheapest picks the least costly model it offers.`
            }
          >
            {(p) => (
              <Select
                {...p}
                value={model}
                disabled={chosen === undefined}
                onChange={(e) => edit({ model: e.target.value })}
              >
                <option value="">Cheapest</option>
                {model !== "" && !offered.some((o) => o.id === model) && (
                  <option value={model}>{model}</option>
                )}
                {offered.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field
          label="Keep or drop on its own above"
          hint="How far above a random guess the decision provider must be (0 is a guess, 1 is certain) before majhi drops a lesson as chatter or merges it into one it has, and logs why. Below it, the lesson is kept, and Undo drops it. Global lessons and contradictions always wait for you. Other decisions use 0.2; memory is stricter because a wrong fact sticks. From 0.2 to 1. Default 0.4."
          error={showErrors ? error : undefined}
        >
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              className="w-24 font-mono"
              value={threshold}
              onChange={(e) => edit({ threshold: e.target.value })}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1">
          <Switch label="Review every fact" checked={reviewAll} onChange={(v) => edit({ reviewAll: v })} />
          <p className="text-sm text-fg-faint text-pretty">
            Nothing is kept or dropped on its own. Facts with a secret or personal data are still rejected.
          </p>
        </div>
        <button type="submit" hidden />
      </form>
    </SaveSection>
  );
}

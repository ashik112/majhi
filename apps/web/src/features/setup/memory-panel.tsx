import type { MemorySettings } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useSaveSettings, useSettings } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";
import { useAccountModels, useAgents } from "@/lib/studio-queries";

export const THRESHOLD_MIN = 0.2;

/** The threshold field's text as a number from 0.2 to 1, or undefined when it is not one. */
export function parseThreshold(text: string): number | undefined {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(value) && value >= THRESHOLD_MIN && value <= 1
    ? value
    : undefined;
}

/** Memory curation: how sure it must be to act alone, reviewing everything, and who reads a finished task's room. */
export function MemoryPanel() {
  const settings = useSettings();
  // Owned here, not in the form: a save changes the settings, which remounts the form, and a
  // remounted form no longer gets the result of the save it started.
  const save = useSaveSettings();
  return (
    <section aria-label="Memory" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-md font-semibold">Memory</h2>
        <span className="text-sm text-fg-faint">Saved to majhi.yaml, as a change you can undo</span>
      </div>
      {settings.isPending && <p className="text-sm text-fg-faint">Loading</p>}
      {settings.isError && <p className="text-sm text-red">{describeError(settings.error)}</p>}
      {/* Remount on a server change so the fields show the saved values. */}
      {settings.data && (
        <MemoryForm key={JSON.stringify(settings.data.memory)} saved={settings.data.memory} save={save} />
      )}
    </section>
  );
}

function MemoryForm({ saved, save }: { saved: MemorySettings; save: ReturnType<typeof useSaveSettings> }) {
  const toast = useToast();
  const agents = useAgents();
  const [threshold, setThreshold] = useState(String(saved.auto_threshold));
  const [reviewAll, setReviewAll] = useState(saved.review_all);
  const [housekeeper, setHousekeeper] = useState(saved.housekeeper ?? "");
  const [model, setModel] = useState(saved.housekeeper_model ?? "");
  const [showErrors, setShowErrors] = useState(false);

  const ok = (agents.data ?? []).flatMap((a) => (a.status === "ok" ? [a] : []));
  const boss = ok.find((a) => a.isBoss)?.agent.frontmatter;
  const chosen =
    housekeeper === "" ? boss : ok.find((a) => a.agent.frontmatter.id === housekeeper)?.agent.frontmatter;
  const models = useAccountModels(chosen?.account);
  const offered = models.data?.models ?? [];

  const parsed = parseThreshold(threshold);
  const error = parsed === undefined ? "Use a number from 0.5 to 1." : undefined;
  const changed =
    parsed !== saved.auto_threshold ||
    reviewAll !== saved.review_all ||
    housekeeper !== (saved.housekeeper ?? "") ||
    model !== (saved.housekeeper_model ?? "");

  function onSubmit() {
    setShowErrors(true);
    if (parsed === undefined || !changed) return;
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
        onSuccess: () => toast("Memory settings saved"),
        onError: (e) => toast("Could not save memory settings", { detail: describeError(e), tone: "error" }),
      },
    );
  }

  return (
    <form
      aria-label="Memory settings"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-3 rounded-[10px] border border-line-strong bg-raised p-3"
    >
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
            onChange={(e) => setThreshold(e.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-col gap-1">
        <Switch label="Review every fact" checked={reviewAll} onChange={setReviewAll} />
        <p className="m-0 text-sm text-fg-faint text-pretty">
          Nothing is kept or dropped on its own. Facts with a secret or personal data are still rejected.
        </p>
      </div>
      <Field
        label="Housekeeper"
        hint="The agent that reads each finished task and writes its record, the project brief and any lessons. This is the only step that spends tokens."
      >
        {(p) => (
          <Select
            {...p}
            value={housekeeper}
            onChange={(e) => {
              setHousekeeper(e.target.value);
              setModel("");
            }}
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
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Cheapest</option>
            {model !== "" && !offered.some((o) => o.id === model) && <option value={model}>{model}</option>}
            {offered.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div>
        <Button type="submit" variant="primary" size="sm" disabled={!changed || save.isPending}>
          Save memory settings
        </Button>
      </div>
    </form>
  );
}

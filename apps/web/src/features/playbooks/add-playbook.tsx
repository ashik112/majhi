import {
  type Cadence,
  CUSTOM_MAX_TOKENS,
  CUSTOM_OUTPUTS,
  type CustomPlaybookSpec,
  type PlaybookView,
} from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, Textarea } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import {
  useCreatePlaybook,
  usePlanPlaybook,
  useRemovePlaybook,
  useUpdatePlaybook,
} from "@/lib/playbook-queries";
import { CadenceFields } from "./cadence-fields";
import { KIND_LABEL, type Kind, kindOf } from "./model";

const BUDGETS: readonly number[] = [2_000, 5_000, 10_000, CUSTOM_MAX_TOKENS];
const PACK_OF: Record<Kind, CustomPlaybookSpec["pack"]> = {
  upkeep: "upkeep",
  code: "engineering",
  business: "business",
};
const OUTPUT_WORD: Record<(typeof CUSTOM_OUTPUTS)[number], string> = {
  finding: "Findings",
  draft: "Drafts",
  log: "Log lines",
};

function specOf(view: PlaybookView): CustomPlaybookSpec {
  const pb = view.playbook;
  return {
    name: pb.name,
    pack: pb.pack === "engineering" || pb.pack === "business" ? pb.pack : "upkeep",
    purpose: pb.purpose,
    cadence: view.cadence,
    steps: pb.steps,
    outputs: pb.outputs.filter((o): o is (typeof CUSTOM_OUTPUTS)[number] =>
      (CUSTOM_OUTPUTS as readonly string[]).includes(o),
    ),
    tokens: pb.cost.tokens === 0 ? 5_000 : pb.cost.tokens,
  };
}

const EMPTY: CustomPlaybookSpec = {
  name: "",
  pack: "upkeep",
  purpose: "",
  cadence: { kind: "daily", at: "08:00" },
  steps: "",
  outputs: ["log"],
  tokens: 5_000,
};

/** The plain form: the same fields the sentence fills. `replace` is a playbook it stands in for (Edit details). */
function ManualForm({
  org,
  initial,
  replace,
  onDone,
}: {
  org: string;
  initial: CustomPlaybookSpec;
  replace: string | undefined;
  onDone: (id: string | undefined) => void;
}) {
  const create = useCreatePlaybook();
  const remove = useRemovePlaybook();
  const toast = useToast();
  const [spec, setSpec] = useState(initial);
  const set = (patch: Partial<CustomPlaybookSpec>) => setSpec({ ...spec, ...patch });
  const valid = spec.name.trim() !== "" && spec.purpose.trim() !== "" && spec.steps.trim() !== "";
  const save = async () => {
    try {
      const view = await create.mutateAsync({ org, spec });
      if (replace !== undefined) await remove.mutateAsync({ org, id: replace });
      onDone(view.playbook.id);
    } catch (e) {
      toast("Could not save it", { detail: describeError(e), tone: "error" });
    }
  };
  return (
    <form
      className="mx-3 mb-2.5 flex flex-col gap-3 rounded-[10px] border border-line bg-raised p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-1 gap-3 min-[1200px]:grid-cols-2">
        <Field label="Name">
          {(p) => (
            <Input {...p} value={spec.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
          )}
        </Field>
        <Field label="Kind">
          {(p) => (
            <Select
              {...p}
              value={kindOf(spec.pack)}
              onChange={(e) => set({ pack: PACK_OF[e.target.value as Kind] })}
            >
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="What it does, in one line">
        {(p) => (
          <Input
            {...p}
            value={spec.purpose}
            maxLength={160}
            onChange={(e) => set({ purpose: e.target.value })}
          />
        )}
      </Field>
      <Field label="Steps">
        {(p) => (
          <Textarea
            {...p}
            rows={4}
            className="font-sans"
            value={spec.steps}
            maxLength={2000}
            onChange={(e) => set({ steps: e.target.value })}
          />
        )}
      </Field>
      <Field label="Runs">
        {() => (
          <CadenceFields
            cadence={spec.cadence}
            withEvents={false}
            onChange={(cadence: Cadence) => set({ cadence })}
          />
        )}
      </Field>
      <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-2">
        <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-sm text-fg-faint">Produces</legend>
          <div className="flex flex-wrap gap-1.5">
            {CUSTOM_OUTPUTS.map((o) => (
              <ChoiceChip
                key={o}
                className="min-h-7 px-2.5 text-xs"
                pressed={spec.outputs.includes(o)}
                onClick={() => {
                  const next = spec.outputs.includes(o)
                    ? spec.outputs.filter((x) => x !== o)
                    : [...spec.outputs, o];
                  if (next.length > 0) set({ outputs: next });
                }}
              >
                {OUTPUT_WORD[o]}
              </ChoiceChip>
            ))}
          </div>
        </fieldset>
        <Field label="Budget per run" className="w-[150px]">
          {(p) => (
            <Select {...p} value={spec.tokens} onChange={(e) => set({ tokens: Number(e.target.value) })}>
              {BUDGETS.map((b) => (
                <option key={b} value={b}>
                  {b / 1000}k tokens
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" type="submit" disabled={!valid || create.isPending}>
          Save, off
        </Button>
        <Button size="sm" type="button" onClick={() => onDone(undefined)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Adds a playbook from a sentence. The captain's cheapest model drafts it and it is saved off; the plan
 * box says what it will do and what it costs, and the owner turns it on, edits it or throws it away.
 * "Set up manually" is the same fields in a plain form.
 */
export function AddPlaybook({ org, onSelect }: { org: string; onSelect: (id: string) => void }) {
  const plan = usePlanPlaybook();
  const update = useUpdatePlaybook();
  const remove = useRemovePlaybook();
  const toast = useToast();
  const [text, setText] = useState("");
  const [planned, setPlanned] = useState<{ view: PlaybookView; plan: string }>();
  const [form, setForm] = useState<{ initial: CustomPlaybookSpec; replace: string | undefined }>();
  const fail = (title: string) => (e: unknown) => toast(title, { detail: describeError(e), tone: "error" });
  const send = () => {
    const sentence = text.trim();
    if (sentence.length < 8) return;
    plan.mutate(
      { text: sentence, org },
      {
        onSuccess: (r) => {
          setPlanned(r);
          setText("");
        },
        onError: fail("Could not plan it"),
      },
    );
  };
  return (
    <>
      <form
        className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input
          aria-label="Add a playbook in a sentence"
          placeholder="Describe a playbook, like: every Monday, draft an update for each client"
          value={text}
          maxLength={500}
          disabled={plan.isPending}
          onChange={(e) => setText(e.target.value)}
        />
        <Button variant="primary" type="submit" disabled={plan.isPending || text.trim().length < 8}>
          {plan.isPending ? "Planning" : "Add"}
        </Button>
        <button
          type="button"
          className="shrink-0 cursor-pointer text-sm whitespace-nowrap text-accent-text hover:underline"
          onClick={() => {
            setPlanned(undefined);
            setForm({ initial: EMPTY, replace: undefined });
          }}
        >
          Set up manually
        </button>
      </form>
      {planned !== undefined && form === undefined && (
        <div className="mx-3 mt-2.5 flex flex-col gap-2 rounded-[10px] border border-line bg-raised p-3">
          <p className="m-0 text-base text-fg-soft text-pretty">
            <b className="font-medium text-fg">{planned.view.playbook.name}.</b> {planned.plan}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { org, id: planned.view.playbook.id, enabled: true },
                  {
                    onSuccess: () => {
                      onSelect(planned.view.playbook.id);
                      setPlanned(undefined);
                    },
                    onError: fail("Could not turn it on"),
                  },
                )
              }
            >
              Turn it on
            </Button>
            <Button
              size="sm"
              onClick={() => setForm({ initial: specOf(planned.view), replace: planned.view.playbook.id })}
            >
              Edit details
            </Button>
            <Button
              size="sm"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { org, id: planned.view.playbook.id },
                  { onSuccess: () => setPlanned(undefined), onError: fail("Could not cancel it") },
                )
              }
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {form !== undefined && (
        <div className="pt-2.5">
          <ManualForm
            org={org}
            initial={form.initial}
            replace={form.replace}
            onDone={(id) => {
              setForm(undefined);
              if (id !== undefined) {
                setPlanned(undefined);
                onSelect(id);
              }
            }}
          />
        </div>
      )}
    </>
  );
}

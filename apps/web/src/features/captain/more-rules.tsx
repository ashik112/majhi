import { type AccountView, type CaptainOrg, type Freeze, PRIVATE } from "@majhi/shared";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChipsInput } from "@/components/ui/chips-input";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useCaptainRules } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { type RulesDraft, rulesDraft, rulesPatch, rulesProblem, shortDay } from "./model";

const PROVIDERS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
] as const;

/**
 * What most owners never change, folded away under each workspace: when the captain may act, the
 * days it does nothing, where it ships and how, which AI tools it may use, and the account that pays
 * for its decisions. One draft, with Cancel and Save showing while something changed.
 */
export function MoreRules({
  org,
  accounts,
  zone,
  onDone,
}: {
  org: CaptainOrg;
  accounts: readonly AccountView[];
  zone: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const save = useCaptainRules();
  const base = useMemo(() => rulesDraft(org.rules), [org.rules]);
  const [draft, setDraft] = useState<RulesDraft>();
  const form = draft ?? base;
  const patch = rulesPatch(form, org.rules);
  const problem = rulesProblem(form);
  const dirty = draft !== undefined && patch !== undefined;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const set = (next: Partial<RulesDraft>) => setDraft({ ...form, ...next });
  // An account of this workspace, or a Private one: never another workspace's.
  const payers = accounts.filter((a) => a.org === org.org || a.org === PRIVATE);

  const addFreeze = () => {
    if (from === "") return;
    const range: Freeze = { from, to: to === "" ? from : to };
    set({ freeze: [...form.freeze, range].sort((a, b) => (a.from < b.from ? -1 : 1)) });
    setFrom("");
    setTo("");
  };
  const submit = () => {
    if (patch === undefined || problem !== undefined) return;
    save.mutate(
      { input: { orgs: { [org.org]: patch } }, reason: `Owner changed ${org.name}'s rules for the captain` },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast(`Saved ${org.name}'s rules`);
        },
        onError: (error) =>
          toast("Could not save the rules", { detail: describeError(error), tone: "error" }),
      },
    );
  };

  return (
    <section
      aria-label={`More rules for ${org.name}`}
      className="flex flex-col gap-4 border-t border-line pt-3.5"
    >
      <div className="grid min-w-0 gap-x-6 gap-y-4 min-[1180px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Switch
            label="Act only in working hours"
            checked={form.hoursOn}
            onChange={(on) => set({ hoursOn: on })}
          />
          {form.hoursOn && (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Input
                type="time"
                aria-label="From"
                value={form.from}
                onChange={(e) => set({ from: e.target.value })}
                className="tnum h-8 w-[112px] font-mono text-sm"
              />
              to
              <Input
                type="time"
                aria-label="To"
                value={form.to}
                onChange={(e) => set({ to: e.target.value })}
                className="tnum h-8 w-[112px] font-mono text-sm"
              />
            </div>
          )}
          <span className="text-xs text-fg-faint text-pretty">
            Outside these hours it does nothing on its own; what comes up waits for the next hour it may act.
          </span>
        </div>
        <Field label="Time zone" hint={`For hours, freeze dates and its day. Empty: ${zone}.`}>
          {(props) => (
            <Input
              {...props}
              value={form.tz}
              placeholder={zone}
              onChange={(e) => set({ tz: e.target.value })}
              className="h-8 text-sm"
            />
          )}
        </Field>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm text-fg-faint">Freeze dates</span>
          {form.freeze.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {form.freeze.map((f) => (
                <li
                  key={`${f.from}..${f.to}`}
                  className="flex h-7 items-center gap-1 rounded-md border border-line-strong bg-card pr-0.5 pl-2.5 text-sm text-fg-soft"
                >
                  {f.from === f.to ? shortDay(f.from) : `${shortDay(f.from)} to ${shortDay(f.to)}`}
                  <button
                    type="button"
                    aria-label={`Remove the freeze from ${f.from} to ${f.to}`}
                    onClick={() => set({ freeze: form.freeze.filter((x) => x !== f) })}
                    className="flex size-6 cursor-pointer items-center justify-center rounded-sm text-fg-faint hover:bg-raised hover:text-fg"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Input
              type="date"
              aria-label="Freeze from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="tnum h-8 w-[150px] font-mono text-sm"
            />
            to
            <Input
              type="date"
              aria-label="Freeze to"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="tnum h-8 w-[150px] font-mono text-sm"
            />
            <Button size="sm" variant="secondary" disabled={from === ""} onClick={addFreeze}>
              Add
            </Button>
          </div>
        </div>
        <Field label="Ships to" hint="The branches it may merge into. Empty: each project's own base branch.">
          {(props) => (
            <ChipsInput
              id={props.id}
              aria-describedby={props["aria-describedby"]}
              label="Ships to"
              value={form.branches}
              placeholder="main, develop"
              onChange={(branches) => set({ branches })}
            />
          )}
        </Field>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm text-fg-faint">AI providers</span>
          <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0" aria-label="AI providers it may use">
            {PROVIDERS.map((p) => (
              <ChoiceChip
                key={p.id}
                pressed={form.providers.length === 0 || form.providers.includes(p.id)}
                onClick={() => {
                  const now =
                    form.providers.length === 0 ? PROVIDERS.map((x) => x.id as string) : form.providers;
                  const next = now.includes(p.id) ? now.filter((x) => x !== p.id) : [...now, p.id];
                  set({ providers: next.length === PROVIDERS.length ? [] : next });
                }}
                className="min-h-8"
              >
                {p.label}
              </ChoiceChip>
            ))}
          </fieldset>
          <span className="text-xs text-fg-faint text-pretty">
            {form.providers.length === 0 ? "Every provider." : `Only ${form.providers.join(", ")}.`} For its
            lane and the work it starts here.
          </span>
        </div>
        <Field label="Pays for its decisions" hint="Only an account of this workspace, or a Private one.">
          {(props) => (
            <Select
              {...props}
              value={form.account}
              onChange={(e) => set({ account: e.target.value })}
              className="h-8 text-sm"
            >
              <option value="">The captain's own account</option>
              {payers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="flex min-h-8 items-center gap-2">
        {problem !== undefined && dirty && (
          <p role="alert" className="text-sm text-red">
            {problem}
          </p>
        )}
        <span className="ml-auto flex items-center gap-2">
          {dirty ? (
            <>
              <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={save.isPending || problem !== undefined}
                onClick={submit}
              >
                {save.isPending ? "Saving" : "Save"}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={onDone}>
              Fold away
            </Button>
          )}
        </span>
      </div>
    </section>
  );
}

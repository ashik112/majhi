import {
  type AccountView,
  type CaptainOrg,
  effectiveHolds,
  type Freeze,
  HOLD_CLASSES,
  HOLD_LABEL,
  type OrgView,
} from "@majhi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChipsInput } from "@/components/ui/chips-input";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { useCaptainRules, useCaptainStatus } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";
import { useAccounts } from "@/lib/studio-queries";
import { type RulesDraft, rulesDraft, rulesPatch, rulesProblem, shortDay } from "./captain-rules-model";

const PROVIDERS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
] as const;

/**
 * What the captain does in this workspace, set by the owner alone: who merges and deploys an incident's fix and
 * who tells the client, the account it runs on here, the daily budget, the days it does nothing, where it ships and
 * which AI tools it may use. Most owners never change them. The first two save at once; the rest are one draft with
 * Cancel and Save while something changed.
 */
export function CaptainRules({ org }: { org: OrgView }) {
  const status = useCaptainStatus().data;
  const accounts = useAccounts().data;
  const mine = status?.orgs.find((o) => o.org === org.id);
  if (mine === undefined) return null;
  return (
    <DetailSection title="Captain">
      <IncidentSwitches org={org} mine={mine} />
      <Rules key={JSON.stringify(mine.rules)} org={mine} accounts={accounts ?? []} />
    </DetailSection>
  );
}

/** Fix and Client update: the owner's choice per workspace. Saved at once through `authority.set`. */
function IncidentSwitches({ org, mine }: { org: OrgView; mine: CaptainOrg }) {
  const toast = useToast();
  const client = useQueryClient();
  const set = useMutation<unknown, ApiRequestError, { fix?: "ask" | "ships"; clientUpdate?: "ask" | "sends" }>({
    mutationFn: (change) =>
      cmd("authority.set", { org: org.id, ...change }, { reason: `Owner changed the incident switches of ${org.name}` }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.settings }),
        client.invalidateQueries({ queryKey: queryKeys.captain }),
      ]),
    onError: (error) => toast("Could not change it", { detail: describeError(error), tone: "error" }),
  });
  const incident = mine.rules.incident;
  return (
    <div className="grid min-w-0 gap-x-6 gap-y-3 min-[1180px]:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm text-fg-faint">Fix</span>
        <Segmented
          label={`Who ships an incident's fix in ${org.name}`}
          value={incident?.fix ?? "ask"}
          segments={[
            { value: "ask", label: "Ask me", disabled: set.isPending },
            { value: "ships", label: "Captain ships", disabled: set.isPending },
          ]}
          onChange={(fix) => set.mutate({ fix })}
          className="self-start"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm text-fg-faint">Client update</span>
        <Segmented
          label={`Who tells the client about an incident in ${org.name}`}
          value={incident?.clientUpdate ?? "ask"}
          segments={[
            { value: "ask", label: "Ask me", disabled: set.isPending },
            { value: "sends", label: "Captain sends", disabled: set.isPending },
          ]}
          onChange={(clientUpdate) => set.mutate({ clientUpdate })}
          className="self-start"
        />
      </div>
    </div>
  );
}

function Rules({ org, accounts }: { org: CaptainOrg; accounts: readonly AccountView[] }) {
  const toast = useToast();
  const save = useCaptainRules();
  const base = useMemo(() => rulesDraft(org.rules, org.budget?.cost), [org.rules, org.budget]);
  const [draft, setDraft] = useState<RulesDraft>();
  const form = draft ?? base;
  const patch = rulesPatch(form, org.rules, org.budget?.cost);
  const problem = rulesProblem(form);
  const dirty = draft !== undefined && patch !== undefined;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const set = (next: Partial<RulesDraft>) => setDraft({ ...form, ...next });
  // The workspace's own accounts: never another workspace's.
  const own = accounts.filter((a) => a.org === org.org);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
        onError: (error) => toast("Could not save the rules", { detail: describeError(error), tone: "error" }),
      },
    );
  };

  return (
    <section aria-label={`Captain rules for ${org.name}`} className="flex flex-col gap-4">
      <div className="grid min-w-0 gap-x-6 gap-y-4 min-[1180px]:grid-cols-2">
        <Field
          label="Captain uses this workspace's account"
          hint={
            org.pays === undefined
              ? "No account may run the captain here yet."
              : `Now it runs on ${org.pays}. Leave it empty to use the captain's own account everywhere.`
          }
        >
          {(props) => (
            <Select
              {...props}
              value={form.account}
              onChange={(e) => set({ account: e.target.value })}
              className="h-8 text-sm"
            >
              <option value="">The captain's own account</option>
              {own.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Daily budget" hint="Dollars a day for the captain's work here. Empty: it shares the Autonomous budget.">
          {(props) => (
            <Input
              {...props}
              inputMode="decimal"
              value={form.budget}
              placeholder="Shared"
              onChange={(e) => set({ budget: e.target.value })}
              className="tnum h-8 w-[140px] font-mono text-sm"
            />
          )}
        </Field>
        <Field label="Time zone" hint={`For freeze dates and its day. Empty: ${zone}.`}>
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
          <span className="text-xs text-fg-faint text-pretty">
            On these days it does nothing on its own; what comes up waits.
          </span>
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
            captain's own turns and the work it starts here.
          </span>
        </div>
      </div>
      <HoldList org={org} />
      <div className="flex min-h-8 items-center gap-2">
        {problem !== undefined && dirty && (
          <p role="alert" className="text-sm text-red">
            {problem}
          </p>
        )}
        {dirty && (
          <span className="ml-auto flex items-center gap-2">
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
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * What the owner keeps for themselves when the captain decides what the clients are told: each switch holds that
 * kind of reply for the owner. A reply with a secret, or one that names another client, waits whatever is set here.
 * Only the owner changes it, and each switch saves at once.
 */
function HoldList({ org }: { org: CaptainOrg }) {
  const toast = useToast();
  const save = useCaptainRules();
  const holds = effectiveHolds(org.rules.holds);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm text-fg-faint">Ask me before sending</span>
      <div className="grid gap-x-6 gap-y-2 min-[600px]:grid-cols-2">
        {HOLD_CLASSES.map((kind) => (
          <Switch
            key={kind}
            label={HOLD_LABEL[kind]}
            checked={holds[kind]}
            disabled={save.isPending}
            onChange={(on) =>
              save.mutate(
                {
                  input: { orgs: { [org.org]: { holds: { [kind]: on } } } },
                  reason: `Owner changed what is held for them in ${org.name}`,
                },
                {
                  onError: (error) => toast("Could not save it", { detail: describeError(error), tone: "error" }),
                },
              )
            }
          />
        ))}
      </div>
    </div>
  );
}


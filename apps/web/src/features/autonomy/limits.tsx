import type { AutonomyStatus } from "@majhi/shared";
import { Fragment, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BROWSER_ZONE } from "@/features/automations/model";
import { useAutonomyCommand } from "@/lib/autonomy-queries";
import { describeError } from "@/lib/errors";
import { useOrgs } from "@/lib/studio-queries";
import { type CapDraft, type LimitsDraft, limitsDraft, limitsPatch, type OrgDraft } from "./model";
import { CardHead } from "./sections";

/** A cost and a tokens field side by side. Empty means no cap of that kind. */
function CapFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: CapDraft;
  onChange: (next: CapDraft) => void;
}) {
  return (
    <>
      <Input
        aria-label={`${label}, dollars`}
        placeholder="$"
        inputMode="decimal"
        value={value.cost}
        onChange={(e) => onChange({ ...value, cost: e.target.value })}
        className="h-8 w-[76px] px-2"
      />
      <Input
        aria-label={`${label}, tokens`}
        placeholder="tokens"
        value={value.tokens}
        onChange={(e) => onChange({ ...value, tokens: e.target.value })}
        className="h-8 w-[84px] px-2"
      />
    </>
  );
}

/**
 * The day cap, each org's cap and its push and merge permission, the account floors and the summary
 * time. Cancel and Save show only while something changed; it saves with `autonomy.configure`, and
 * the browser's zone goes along so the day and the summary time follow the owner's clock.
 */
export function LimitsCard({ status }: { status: AutonomyStatus }) {
  const orgs = useOrgs().data;
  const ids = useId();
  const settings = status.settings;
  // The org ids by value, so a refetch of the same orgs keeps the form as it is.
  const orgKey = (orgs ?? []).map((o) => o.id).join(" ");
  const base = useMemo(
    () => limitsDraft(settings, orgKey === "" ? [] : orgKey.split(" ")),
    [settings, orgKey],
  );
  const [draft, setDraft] = useState<LimitsDraft>();
  const [problem, setProblem] = useState<string>();
  const save = useAutonomyCommand("autonomy.configure");
  const form = draft ?? base;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(base);
  const name = (id: string) => orgs?.find((o) => o.id === id)?.name ?? id;

  const edit = (change: Partial<LimitsDraft>) => {
    setProblem(undefined);
    setDraft({ ...form, ...change });
  };
  const editOrg = (id: string, change: Partial<OrgDraft>) => {
    const row = form.orgs[id] ?? { cost: "", tokens: "", push: false, merge: false };
    edit({ orgs: { ...form.orgs, [id]: { ...row, ...change } } });
  };
  const submit = () => {
    const out = limitsPatch(form, settings, BROWSER_ZONE);
    if ("problem" in out) return setProblem(out.problem);
    save.mutate(
      { input: out.patch, reason: "Owner changed the limits of autonomous mode" },
      { onSuccess: () => setDraft(undefined) },
    );
  };

  return (
    <Card aria-label="Limits" id="limits">
      <CardHead title="Limits">
        {(dirty || save.isPending) && (
          <>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={save.isPending} onClick={submit}>
              {save.isPending ? "Saving" : "Save"}
            </Button>
          </>
        )}
      </CardHead>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 text-sm">
        <span className="text-fg-soft">Day cap, all workspaces together</span>
        <span className="flex gap-1.5">
          <CapFields label="Day cap" value={form.day} onChange={(day) => edit({ day })} />
        </span>
        <label htmlFor={`${ids}-window`} className="text-fg-soft">
          Keep of each 5-hour window, %
        </label>
        <Input
          id={`${ids}-window`}
          inputMode="numeric"
          value={form.window}
          onChange={(e) => edit({ window: e.target.value })}
          className="h-8 w-[76px] justify-self-end px-2"
        />
        <label htmlFor={`${ids}-weekly`} className="text-fg-soft">
          Keep of each week, %
        </label>
        <Input
          id={`${ids}-weekly`}
          inputMode="numeric"
          value={form.weekly}
          onChange={(e) => edit({ weekly: e.target.value })}
          className="h-8 w-[76px] justify-self-end px-2"
        />
        <label htmlFor={`${ids}-summary`} className="text-fg-soft">
          Daily summary at
        </label>
        <Input
          id={`${ids}-summary`}
          type="time"
          value={form.summaryAt}
          onChange={(e) => edit({ summaryAt: e.target.value })}
          className="h-8 w-[124px] justify-self-end px-2"
        />
      </div>
      {Object.keys(form.orgs).length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 text-sm">
          <span className="pb-1 text-xs text-fg-faint">Workspace</span>
          <span className="pb-1 text-xs text-fg-faint">Cap a day</span>
          <span className="pb-1 text-xs text-fg-faint">Push</span>
          <span className="pb-1 text-xs text-fg-faint">Merge</span>
          {Object.entries(form.orgs).map(([id, row]) => (
            <Fragment key={id}>
              <span className="truncate border-t border-line py-1.5 text-fg-soft">{name(id)}</span>
              <span className="flex gap-1.5 border-t border-line py-1.5">
                <CapFields label={`Cap of ${name(id)}`} value={row} onChange={(cap) => editOrg(id, cap)} />
              </span>
              <span className="border-t border-line py-1.5">
                <Switch
                  label={`May push ${name(id)}`}
                  hideLabel
                  checked={row.push}
                  onChange={(push) => editOrg(id, { push })}
                />
              </span>
              <span className="border-t border-line py-1.5">
                <Switch
                  label={`May merge ${name(id)}`}
                  hideLabel
                  checked={row.merge}
                  onChange={(merge) => editOrg(id, { merge })}
                />
              </span>
            </Fragment>
          ))}
        </div>
      )}
      <p className="text-xs text-fg-faint text-pretty">
        Push lets it push task branches and open MRs. Merge lets it merge into the base branch, and merge MRs
        where the workspace's own merge policy allows. Days and the summary time follow {BROWSER_ZONE}, this
        browser's zone.
      </p>
      {(problem ?? save.error) && (
        <p role="alert" className="text-sm text-red">
          {problem ?? `Could not save: ${describeError(save.error)}`}
        </p>
      )}
    </Card>
  );
}

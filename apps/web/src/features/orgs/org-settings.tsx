import { IdSchema, type OrgView, PRIVATE } from "@majhi/shared";
import { Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { Select } from "@/components/ui/select";
import { ORG_COLORS, orgColorName } from "@/features/accounts/model";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { HOST_LABEL } from "@/lib/hosts";
import { useRenameOrg, useSaveSecret, useUpdateOrg } from "@/lib/studio-queries";
import { checkOrgDraft, draftFromOrg, MR_HOSTS, type OrgDraft, type OrgErrors } from "./model";
import { MrSettings } from "./mr-settings";

/**
 * The org's settings, always open where they sit. Cancel and Save show while something changed;
 * a new id renames the org first, then the rest saves under the new id.
 */
export function OrgSettings({ org, onRenamed }: { org: OrgView; onRenamed: (id: string) => void }) {
  const update = useUpdateOrg();
  const rename = useRenameOrg();
  const saveSecret = useSaveSecret();
  const [orgId, setOrgId] = useState(org.id);
  const [draft, setDraft] = useState<OrgDraft>(() => draftFromOrg(org));
  const [errors, setErrors] = useState<OrgErrors>({});
  const [failure, setFailure] = useState<string>();
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<OrgDraft>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const busy = update.isPending || rename.isPending || saveSecret.isPending;
  const typedToken = MR_HOSTS.some((h) => draft.newTokens[h].trim() !== "");
  const check = checkOrgDraft(org, draft);
  const dirty = orgId.trim() !== org.id || typedToken || !check.ok || check.input !== undefined;

  function reset() {
    setOrgId(org.id);
    setDraft(draftFromOrg(org));
    setErrors({});
    setFailure(undefined);
  }

  async function submit() {
    setFailure(undefined);
    // A token typed for a host becomes a secret first; the org keeps only its reference.
    let mrTokens = draft.mrTokens;
    try {
      for (const host of MR_HOSTS) {
        const value = draft.newTokens[host].trim();
        if (value === "") continue;
        const secret = await saveSecret.mutateAsync({
          value,
          label: `${org.name} ${HOST_LABEL[host]} token`,
        });
        mrTokens = { ...mrTokens, [host]: secret.ref };
      }
    } catch (e) {
      setFailure(describeError(e));
      return;
    }
    // The typed values are spent: a retry after a failed save must not save them again.
    const next = { ...draft, mrTokens, newTokens: { github: "", gitlab: "", bitbucket: "" } };
    setDraft(next);
    const result = checkOrgDraft(org, next);
    if (!result.ok) return setErrors(result.errors);
    const nextId = orgId.trim();
    if (nextId !== org.id && !IdSchema.safeParse(nextId).success) {
      setFailure("Org id: use lowercase letters, digits and dashes");
      return;
    }
    setErrors({});
    const done = () => setSaved(true);
    const save = (id: string) => {
      if (!result.input) return done();
      update.mutate(
        { ...result.input, id },
        { onSuccess: done, onError: (e) => setFailure(describeError(e)) },
      );
    };
    if (nextId === org.id) return save(org.id);
    rename.mutate(
      { id: org.id, newId: nextId },
      {
        onSuccess: () => {
          onRenamed(nextId);
          save(nextId);
        },
        onError: (e) => setFailure(describeError(e)),
      },
    );
  }

  const colors =
    draft.color && !ORG_COLORS.some((c) => c === draft.color) ? [...ORG_COLORS, draft.color] : ORG_COLORS;
  const buttons = (
    <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={reset}>
        Cancel
      </Button>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void submit()}>
        {busy ? "Saving" : "Save settings"}
      </Button>
    </>
  );
  const actions = (
    <>
      <span role="status" aria-live="polite" className="flex items-center gap-1 text-sm text-fg-faint">
        {saved && !dirty && (
          <>
            <Check aria-hidden="true" className="size-3 text-green" />
            Saved
          </>
        )}
      </span>
      {(dirty || busy) && buttons}
    </>
  );

  return (
    <DetailSection title="Settings" actions={actions}>
      <form
        aria-label={`Settings of ${org.name}`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-5"
      >
        <div className="grid gap-3 @[560px]:grid-cols-2">
          <Field label="Name" error={errors.name}>
            {(p) => <Input {...p} value={draft.name} onChange={(e) => set({ name: e.target.value })} />}
          </Field>
          <Field
            label="Org id"
            hint={
              org.id === PRIVATE
                ? "The built-in org keeps its id."
                : "Renaming updates its agents, accounts and projects. Task keys stay."
            }
          >
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                disabled={org.id === PRIVATE}
                value={orgId}
                onChange={(e) => {
                  setSaved(false);
                  setOrgId(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Task key" error={errors.key} hint="Like GLX for GLX-420.">
            {(p) => (
              <Input
                {...p}
                className="font-mono uppercase"
                value={draft.key}
                onChange={(e) => set({ key: e.target.value })}
              />
            )}
          </Field>
          <Field label="Base branch" hint="Blank uses each repo's default.">
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                placeholder="main"
                value={draft.base}
                onChange={(e) => set({ base: e.target.value })}
              />
            )}
          </Field>
          <Field label="Commit name" error={errors.identityName}>
            {(p) => (
              <Input
                {...p}
                placeholder="Your name"
                value={draft.identityName}
                onChange={(e) => set({ identityName: e.target.value })}
              />
            )}
          </Field>
          <Field label="Commit email" error={errors.identityEmail}>
            {(p) => (
              <Input
                {...p}
                type="email"
                placeholder="you@company.com"
                value={draft.identityEmail}
                onChange={(e) => set({ identityEmail: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Resume interrupted work"
            hint="After a restart, lost internet or sleep, without you clicking."
          >
            {(p) => (
              <Select
                {...p}
                value={draft.resume}
                onChange={(e) => set({ resume: e.target.value as OrgDraft["resume"] })}
              >
                <option value="default">majhi's setting</option>
                <option value="on">On its own</option>
                <option value="off">Wait for me</option>
              </Select>
            )}
          </Field>
          <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 p-0 text-sm text-fg-faint">Color</legend>
            <div className="flex h-[34px] items-center gap-2">
              {colors.map((c) => {
                const on = draft.color === c;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={orgColorName(c)}
                    aria-pressed={on}
                    title={orgColorName(c)}
                    onClick={() => set({ color: c })}
                    style={{ backgroundColor: c }}
                    className={cn(
                      "flex size-7 cursor-pointer items-center justify-center rounded-full text-canvas transition-shadow duration-150",
                      on
                        ? "shadow-[0_0_0_2px_var(--c-canvas),0_0_0_3.5px_var(--c-fg)]"
                        : "hover:shadow-[0_0_0_2px_var(--c-canvas),0_0_0_3.5px_var(--c-line-hover)]",
                    )}
                  >
                    {on && <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
            {errors.color && <p className="text-sm text-red">{errors.color}</p>}
          </fieldset>
        </div>
        <MrSettings draft={draft} error={errors.mrTokens} onChange={set} />
        {failure && (
          <p role="alert" className="text-sm text-red text-pretty">
            {failure}
          </p>
        )}
        {(dirty || busy) && <div className="flex justify-end gap-2">{buttons}</div>}
      </form>
    </DetailSection>
  );
}

import type { MergePolicy, MrHost } from "@majhi/shared";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { HOST_LABEL } from "@/lib/hosts";
import { useSecrets } from "@/lib/studio-queries";
import { MR_HOSTS, type OrgDraft } from "./model";

const POLICY_HINT: Record<MergePolicy, string> = {
  never: "majhi opens the merge requests. You merge on the host, then tell majhi.",
  approve: "You click Merge in order. majhi merges each repo in order and stops at the first failure.",
  "auto-if-green": "majhi merges in order once every check passes.",
};

/** The org's merge policy and where each MR host's token comes from. Tokens are saved secrets, never shown. */
export function MrSettings({
  draft,
  error,
  onChange,
}: {
  draft: OrgDraft;
  error: string | undefined;
  onChange: (patch: Partial<OrgDraft>) => void;
}) {
  const secrets = useSecrets().data ?? [];
  const setToken = (host: MrHost, patch: { ref?: string; fresh?: string }) =>
    onChange({
      ...(patch.ref !== undefined && { mrTokens: { ...draft.mrTokens, [host]: patch.ref } }),
      ...(patch.fresh !== undefined && { newTokens: { ...draft.newTokens, [host]: patch.fresh } }),
    });

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-sm text-fg-faint">Merge requests</legend>
      <Field label="Merge policy" hint={POLICY_HINT[draft.merge]}>
        {(p) => (
          <Select
            {...p}
            value={draft.merge}
            onChange={(e) => onChange({ merge: e.target.value as MergePolicy })}
          >
            <option value="never">Never: I merge on the host</option>
            <option value="approve">Approve: majhi merges when I click</option>
            <option value="auto-if-green">Auto if green: majhi merges once checks pass</option>
          </Select>
        )}
      </Field>
      {MR_HOSTS.map((host) => (
        <div key={host} className="grid grid-cols-2 gap-2">
          <Field label={`${HOST_LABEL[host]} token`} hint="A saved secret.">
            {(p) => (
              <Select
                {...p}
                value={draft.mrTokens[host]}
                onChange={(e) => setToken(host, { ref: e.target.value })}
              >
                <option value="">Not set</option>
                {secrets.map((s) => (
                  <option key={s.name} value={s.ref}>
                    {s.name}
                  </option>
                ))}
                {draft.mrTokens[host] !== "" && !secrets.some((s) => s.ref === draft.mrTokens[host]) && (
                  <option value={draft.mrTokens[host]}>{draft.mrTokens[host]}</option>
                )}
              </Select>
            )}
          </Field>
          <Field label="Or paste a new one" hint="Saved as a secret. majhi keeps only its reference.">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                placeholder="Token"
                value={draft.newTokens[host]}
                onChange={(e) => setToken(host, { fresh: e.target.value })}
              />
            )}
          </Field>
        </div>
      ))}
      {error && <p className="text-sm text-red">{error}</p>}
    </fieldset>
  );
}

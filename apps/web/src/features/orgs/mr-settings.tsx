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
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="mb-3 p-0 text-base font-semibold text-fg">Merge requests</legend>
      <Field label="Merge policy" hint={POLICY_HINT[draft.merge]} className="@[560px]:max-w-[calc(50%-6px)]">
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
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-fg-faint">
          Host tokens. Pick a saved secret, or paste a new token and majhi saves it as one.
        </span>
        <div className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
          {MR_HOSTS.map((host) => {
            const current = draft.mrTokens[host];
            return (
              <div key={host} className="contents">
                <span className="text-sm text-fg-soft">{HOST_LABEL[host]}</span>
                <Select
                  aria-label={`${HOST_LABEL[host]} token`}
                  value={current}
                  onChange={(e) => setToken(host, { ref: e.target.value })}
                >
                  <option value="">Not set</option>
                  {secrets.map((s) => (
                    <option key={s.name} value={s.ref}>
                      {s.name}
                    </option>
                  ))}
                  {current !== "" && !secrets.some((s) => s.ref === current) && (
                    <option value={current}>{current}</option>
                  )}
                </Select>
                <Input
                  aria-label={`New ${HOST_LABEL[host]} token`}
                  type="password"
                  autoComplete="new-password"
                  placeholder="Paste a new token"
                  value={draft.newTokens[host]}
                  onChange={(e) => setToken(host, { fresh: e.target.value })}
                />
              </div>
            );
          })}
        </div>
      </div>
      {error && <p className="text-sm text-red">{error}</p>}
    </fieldset>
  );
}

import type { MergePolicy } from "@majhi/shared";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import type { OrgDraft } from "./model";

const POLICY_HINT: Record<MergePolicy, string> = {
  never: "majhi opens the merge requests. You merge on the host, then tell majhi.",
  approve: "You click Merge in order. majhi merges each repo in order and stops at the first failure.",
  "auto-if-green": "majhi merges in order once every check passes.",
};

/** The org's merge policy. Tokens live with the git accounts. */
export function MrSettings({
  draft,
  onChange,
}: {
  draft: OrgDraft;
  onChange: (patch: Partial<OrgDraft>) => void;
}) {
  return (
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
  );
}

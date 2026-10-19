import {
  AUTHORITY_LEVELS,
  type AuthorityLevel,
  LEVEL_LABEL,
  levelOfOrg,
  type OrgView,
  PRIVATE,
} from "@majhi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { useSettings } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";

const SAYS: Record<AuthorityLevel, string> = {
  ask: "Agents work inside their task. Pushing, merging, deploying and messages all ask you.",
  routine: "Also pushes a task's own branch and opens a draft pull request. Merging and deploying ask you.",
  full: "Also merges into main and deploys to staging. Production, client messages and writes on client servers still ask.",
};

/**
 * The workspace's one authority level: what agents and the captain may do here without asking. It is the
 * workspace's policy for push, merge and outbound messages, so only this control sets it. It saves at once.
 */
export function AuthorityLevelField({ org }: { org: OrgView }) {
  const toast = useToast();
  const client = useQueryClient();
  const settings = useSettings();
  const set = useMutation<unknown, ApiRequestError, AuthorityLevel>({
    mutationFn: (level) =>
      cmd(
        "authority.set",
        { org: org.id, level },
        { reason: `Owner set the authority level of ${org.name} to ${LEVEL_LABEL[level]}` },
      ),
    onSuccess: async (_, level) => {
      toast(`${org.name}: ${LEVEL_LABEL[level]}`);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.settings }),
        client.invalidateQueries({ queryKey: queryKeys.captain }),
      ]);
    },
    onError: (error) => toast("Could not change it", { detail: describeError(error), tone: "error" }),
  });
  const level = levelOfOrg(settings.data?.autonomy.orgs[org.id], org.id === PRIVATE);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm text-fg-faint">Authority</span>
      <Segmented
        label={`Authority level of ${org.name}`}
        value={level}
        segments={AUTHORITY_LEVELS.map((value) => ({
          value,
          label: LEVEL_LABEL[value],
          disabled: set.isPending || settings.data === undefined,
        }))}
        onChange={(value) => {
          if (value !== level) set.mutate(value);
        }}
        className="self-start"
      />
      <p className="break-words text-sm text-pretty text-fg-faint">{SAYS[level]}</p>
    </div>
  );
}

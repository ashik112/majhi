import { useMemo } from "react";
import { GitSignInPanel } from "@/features/git-signin/panel";
import { useOnboardingStatus } from "@/lib/onboarding-queries";
import { useOrgs } from "@/lib/studio-queries";

/**
 * Asked the first time a task wants to push and the workspace has no git sign-in for the host: the sign-in
 * itself, in the room, where the work waits. Setup no longer asks for it.
 */
export function GitSignInCard({ org }: { org: string }) {
  const orgs = useOrgs().data;
  const status = useOnboardingStatus().data;
  const names = useMemo(() => new Map((status?.workspaces ?? []).map((w) => [w.id, w.name])), [status]);
  const name = orgs?.find((o) => o.id === org)?.name ?? org;
  const git = status?.workspaces.find((w) => w.id === org)?.git ?? [];
  return (
    <div className="flex flex-col gap-2 pl-4">
      <p className="m-0 text-sm text-fg">
        {name} is not signed in to git yet, so majhi cannot push. Sign in once and it pushes as that account.
      </p>
      <GitSignInPanel workspace={{ id: org, name }} git={git} names={names} showSigned={false} />
    </div>
  );
}

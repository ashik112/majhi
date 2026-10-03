import { type Fact, type OrgView, PRIVATE, parseScope } from "@majhi/shared";
import { ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { Menu } from "@/components/ui/menu";
import { ReviewNowButton, useStartReview } from "@/features/captain/review-now";
import { GLOBAL } from "./model";

type OrgName = Pick<OrgView, "id" | "name">;

/** The workspace whose memory chore reviews a scope: Private for global, else the org of the project or org. */
function reviewerOf(scope: string, projectOrgs: ReadonlyMap<string, string | undefined>): string | undefined {
  const parsed = parseScope(scope);
  if (parsed === undefined) return undefined;
  if (parsed.kind === "global") return PRIVATE;
  if (parsed.kind === "org") return parsed.id;
  return projectOrgs.get(parsed.id) ?? PRIVATE;
}

/**
 * "Review now" in the Memory header: the captain reviews the waiting memories of the selected
 * scope's workspace now. The menu next to it reviews another workspace or all of them.
 */
export function MemoryReviewActions({
  facts,
  projectOrgs,
  orgs,
  selected,
}: {
  facts: readonly Fact[];
  projectOrgs: ReadonlyMap<string, string | undefined>;
  orgs: readonly OrgName[];
  selected: string;
}) {
  const start = useStartReview();
  const waiting = useMemo(() => {
    const by = new Map<string, number>();
    for (const f of facts) {
      if (f.status !== "pending") continue;
      const org = reviewerOf(f.scope, projectOrgs);
      if (org !== undefined) by.set(org, (by.get(org) ?? 0) + 1);
    }
    return by;
  }, [facts, projectOrgs]);
  const own = selected === GLOBAL ? PRIVATE : (projectOrgs.get(selected) ?? PRIVATE);
  const total = [...waiting.values()].reduce((n, c) => n + c, 0);
  const nameOf = (id: string) => orgs.find((o) => o.id === id)?.name ?? (id === PRIVATE ? "Private" : id);
  const others = [...waiting.entries()].filter(([, count]) => count > 0);

  return (
    <div className="flex items-start gap-1">
      <ReviewNowButton org={own} waiting={waiting.get(own) ?? 0} />
      {others.length > 0 && (
        <Menu
          label="Review other workspaces"
          icon={<ChevronDown aria-hidden="true" />}
          items={[
            ...(others.length > 1
              ? [
                  {
                    label: `All workspaces (${total})`,
                    onSelect: () => {
                      for (const [org, count] of others) start.start(org, "memory", count);
                    },
                  },
                ]
              : []),
            ...others.map(([org, count]) => ({
              label: `${nameOf(org)} (${count})`,
              onSelect: () => start.start(org, "memory", count),
            })),
          ]}
        />
      )}
    </div>
  );
}

import { type CaptainStatus, PRIVATE } from "@majhi/shared";
import { InstructionsCard } from "@/features/autonomy/guide";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { badgeLetters } from "@/lib/format";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { PickCard } from "./pick-card";
import { WorkspaceCard } from "./workspace-card";

/**
 * The Rules tab: what holds for every workspace (the largest task it starts, the standing
 * instructions), then one card per workspace with who decides what, its budget line and the tasks
 * to leave alone. The money itself is on the Limits screen.
 */
export function RulesTab({ captain, now }: { captain: CaptainStatus; now: number }) {
  const orgs = useOrgs().data ?? [];
  const accounts = useAccounts().data ?? [];
  const autonomy = useAutonomyStatus().data;
  const zone = autonomy?.settings.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pb-6 scroll-fade">
      {captain.captain === undefined && (
        <p className="rounded-xl border border-amber-line bg-amber-wash px-4 py-2.5 text-sm text-amber text-pretty">
          There is no captain yet. Choose one on the Agents page; until then nothing here runs.
        </p>
      )}
      {autonomy && (
        <div className="grid min-w-0 items-start gap-3 xl:grid-cols-2">
          <PickCard status={autonomy} />
          <InstructionsCard status={autonomy} now={now} />
        </div>
      )}
      <div className="grid min-w-0 items-start gap-3 min-[1360px]:grid-cols-2">
        {captain.orgs.map((org) => {
          const view = orgs.find((o) => o.id === org.org);
          return (
            <WorkspaceCard
              key={org.org}
              org={org}
              badge={
                view === undefined
                  ? org.org === PRIVATE
                    ? "PR"
                    : badgeLetters(org.name)
                  : badgeLetters(view.key)
              }
              color={view?.color}
              accounts={accounts}
              autonomyOn={captain.autonomy === "on"}
              dayCap={autonomy?.settings.day.cost}
              zone={zone}
              status={autonomy}
            />
          );
        })}
      </div>
    </div>
  );
}

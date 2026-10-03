import { type AccountView, type AutonomyStatus, type CaptainOrg, CHORE_LABEL, PRIVATE } from "@majhi/shared";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Lamp } from "@/components/ui/lamp";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageLink } from "@/components/ui/page-link";
import { useToast } from "@/components/ui/toast";
import { budgetShort } from "@/features/limits/budget-ask";
import { useCaptainCommand } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { AuthorityTable } from "./authority-table";
import { MoreRules } from "./more-rules";
import { LeaveAloneList } from "./pick-card";

/** "Budget: $20 a day, $4.20 used today", or what the workspace shares when it has none of its own. */
function budgetLine(org: CaptainOrg, dayCap: number | undefined): string {
  const used = `${formatMoney(org.used.cost)} used today`;
  if (org.budget !== undefined) return `Budget: ${budgetShort(org.budget)} a day, ${used}`;
  return dayCap === undefined
    ? `No budget set, ${used}`
    : `Budget: shares the autonomous ${budgetShort({ cost: dayCap })} a day, ${used}`;
}

/** A folded section of the card: a button with a count, and its body under it when open. */
function Fold({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count?: number | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-sm text-fg-muted underline decoration-line-bright underline-offset-[3px] hover:text-fg"
    >
      {label}
      {count !== undefined && <span className="tnum font-mono text-fg-faint no-underline">{count}</span>}
      <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-180")} />
    </button>
  );
}

/**
 * One workspace on the Rules tab: who decides what, a one-line budget with the way to the Limits
 * screen, chores that turned off, the tasks to leave alone and "More rules", both folded away.
 */
export function WorkspaceCard({
  org,
  badge,
  color,
  accounts,
  autonomyOn,
  dayCap,
  zone,
  status,
}: {
  org: CaptainOrg;
  badge: string;
  color: string | undefined;
  accounts: readonly AccountView[];
  autonomyOn: boolean;
  dayCap: number | undefined;
  zone: string;
  /** Autonomous status, for the backlog; absent while it loads or is not ready. */
  status: AutonomyStatus | undefined;
}) {
  const toast = useToast();
  const choreOn = useCaptainCommand("captain.choreOn");
  const [open, setOpen] = useState<"leave" | "more">();
  const toggle = (which: "leave" | "more") => setOpen(open === which ? undefined : which);
  const off = org.chores.filter((c) => c.off !== undefined);
  const backlog = status?.backlog.filter((b) =>
    org.org === PRIVATE ? b.org === undefined : b.org === org.org,
  );
  let body: ReactNode = null;
  if (open === "leave" && status)
    body = <LeaveAloneList status={status} org={org.org === PRIVATE ? undefined : org.org} />;
  if (open === "more")
    body = <MoreRules org={org} accounts={accounts} zone={zone} onDone={() => setOpen(undefined)} />;
  return (
    <Card aria-label={org.name} className="gap-3 rounded-2xl px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <OrgBadge
          label={badge}
          color={color}
          size="md"
          className={org.org === PRIVATE ? "bg-fg-faint" : ""}
        />
        <h2 className="min-w-0 truncate text-md font-semibold text-fg">{org.name}</h2>
      </div>
      <AuthorityTable org={org} autonomyOn={autonomyOn} />
      {off.map((c) => (
        <div key={c.chore} className="flex min-w-0 items-center gap-2 text-sm">
          <Lamp state="paused" size={7} />
          <span className="min-w-0 flex-1 truncate text-fg-soft" title={c.off}>
            {CHORE_LABEL[c.chore]} is off: {c.off}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={choreOn.isPending}
            onClick={() =>
              choreOn.mutate(
                {
                  input: { org: org.org, chore: c.chore },
                  reason: `Owner turned ${CHORE_LABEL[c.chore]} on again in ${org.name}`,
                },
                { onSuccess: () => toast(`${CHORE_LABEL[c.chore]} is on again in ${org.name}`) },
              )
            }
          >
            Turn on
          </Button>
        </div>
      ))}
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <p className="tnum min-w-0 text-sm text-fg-muted">
          {budgetLine(org, dayCap)}.{" "}
          <PageLink page="limits" className="text-blue hover:underline">
            Edit budgets
          </PageLink>
        </p>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {backlog !== undefined && (
            <Fold
              label="Leave tasks alone"
              count={backlog.length}
              open={open === "leave"}
              onToggle={() => toggle("leave")}
            />
          )}
          <Fold label="More rules" open={open === "more"} onToggle={() => toggle("more")} />
        </span>
      </div>
      {body && <div className="min-w-0 border-t border-line pt-3">{body}</div>}
    </Card>
  );
}

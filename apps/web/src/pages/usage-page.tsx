import { USAGE_TABS } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { TabBar } from "@/components/ui/tab-bar";
import { AuditView } from "@/features/audit/audit-view";
import { HealthView } from "@/features/health/health-view";
import type { AppSearch } from "@/router";

/** The Usage place: health and cost, and the activity log (the old audit log) as its second tab. */
export function UsagePage() {
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const tab = search.tab === "activity" ? "activity" : "health";
  const tabs = (
    <TabBar
      label="Usage"
      tabs={USAGE_TABS}
      value={tab}
      onChange={(next) =>
        void navigate({
          to: ".",
          search: (prev: AppSearch): AppSearch => {
            const { tab: _tab, ...rest } = prev;
            return next === "health" ? rest : { ...rest, tab: next };
          },
          replace: true,
        })
      }
    />
  );
  return tab === "activity" ? <AuditView tabs={tabs} /> : <HealthView tabs={tabs} />;
}

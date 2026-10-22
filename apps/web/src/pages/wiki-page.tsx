import { WIKI_TABS } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { TabBar } from "@/components/ui/tab-bar";
import { MemoryView } from "@/features/memory/memory-view";
import { WikiView } from "@/features/wiki/wiki-view";
import type { AppSearch } from "@/router";

/** The Wiki place: the project's architecture pages, and Memory (what majhi keeps per project) as its second tab. */
export function WikiPage() {
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const tab = search.tab === "memory" ? "memory" : "pages";
  const tabs = (
    <TabBar
      label="Wiki"
      tabs={WIKI_TABS}
      value={tab}
      onChange={(next) =>
        void navigate({
          to: ".",
          // Memory's own tab and the dialogs belong to one tab, so they do not travel with the switch.
          search: (prev: AppSearch): AppSearch => {
            const { tab: _tab, mtab: _mtab, rules: _rules, settings: _settings, ...rest } = prev;
            return next === "memory" ? { ...rest, tab: "memory" } : rest;
          },
          replace: true,
        })
      }
    />
  );
  return tab === "memory" ? <MemoryView tabs={tabs} /> : <WikiView tabs={tabs} />;
}

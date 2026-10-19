import { PAGE_PATH, PRIVATE, PRIVATE_NAME } from "@majhi/shared";
import { Link, useRouterState } from "@tanstack/react-router";
import { Search, Settings } from "lucide-react";
import { AppearanceButton } from "@/components/shell/appearance";
import { Menu } from "@/components/ui/menu";
import { MOD_KEY } from "@/lib/format";
import { useFeedLost } from "@/lib/feed-status";
import { useOrgFilter } from "@/lib/org-filter";
import { isSettingsPath } from "@/features/settings/settings-frame";
import { useConsole } from "./data-context";
import { ConsoleLamp, Kbd, wsStyle } from "./parts";

/** How many workspaces get a button before the rest go under "N more". */
const SHOWN = 5;

function Workspaces() {
  const { orgs, hues, waitingByOrg } = useConsole();
  const { org, setOrg } = useOrgFilter();
  const all = [
    ...(orgs ?? []).filter((o) => o.id !== PRIVATE).map((o) => ({ id: o.id, name: o.name })),
    { id: PRIVATE, name: PRIVATE_NAME },
  ];
  const several = all.length > SHOWN + 1;
  const shown = several ? all.slice(0, SHOWN) : all;
  // The picked workspace always shows, even when it would fall under "more".
  const picked = all.find((w) => w.id === org);
  if (picked !== undefined && !shown.includes(picked)) shown.push(picked);
  const rest = all.filter((w) => !shown.includes(w));
  return (
    <div className="cs-seg" role="group" aria-label="Workspace">
      <button type="button" aria-pressed={org === undefined} onClick={() => setOrg(undefined)}>
        All
      </button>
      {shown.map((w) => {
        const waiting = waitingByOrg.get(w.id) ?? 0;
        return (
          <button
            key={w.id}
            type="button"
            aria-pressed={org === w.id}
            title={w.name}
            style={wsStyle(hues, w.id)}
            onClick={() => setOrg(w.id)}
          >
            <span className="cs-wsdot" aria-hidden="true" />
            {w.name.split(" ")[0]}
            {waiting > 0 && <span className="cs-c">{waiting}</span>}
          </button>
        );
      })}
      {rest.length > 0 && (
        <Menu
          label="More workspaces"
          align="left"
          items={rest.map((w) => ({ label: w.name, onSelect: () => setOrg(w.id) }))}
          trigger={(t) => (
            <button type="button" {...t}>
              {rest.length} more
            </button>
          )}
        />
      )}
    </div>
  );
}

/** The bar above every screen: workspace filter, what is going on, search, appearance, Settings. */
export function TopBar({ onSearch }: { onSearch: () => void }) {
  const { counts } = useConsole();
  const lost = useFeedLost();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const inSettings = isSettingsPath(path);
  return (
    <header className="cs-top cs-glass">
      <Link to="/" className="cs-mark" aria-label="majhi: back to the console">
        mj
      </Link>
      <Workspaces />
      {lost && (
        <div className="cs-conn" role="status">
          <ConsoleLamp state="paused" />
          Offline
        </div>
      )}
      <div className="cs-tele">
        {counts.incidents > 0 && (
          <>
            <span className="cs-inc cs-on">
              <b>{counts.incidents}</b>
              {counts.incidents === 1 ? "incident" : "incidents"}
            </span>
            <i />
          </>
        )}
        <span className={counts.needYou > 0 ? "cs-on" : undefined}>
          <b>{counts.needYou}</b>need you
        </span>
        <i />
        <span className={counts.working > 0 ? "cs-on" : undefined}>
          <b>{counts.working}</b>working
        </span>
        <i className="cs-q" />
        <span className={`cs-q ${counts.queued > 0 ? "cs-on" : ""}`}>
          <b>{counts.queued}</b>queued
        </span>
      </div>
      <button type="button" className="cs-search" onClick={onSearch} aria-label="Search or ask">
        <Search aria-hidden="true" width={14} height={14} />
        Search or ask
        <span className="cs-kbd" style={{ marginLeft: "auto" }}>
          {MOD_KEY}K
        </span>
      </button>
      <AppearanceButton />
      <Link
        to={PAGE_PATH.setup}
        className="cs-iconbtn"
        aria-label="Settings"
        aria-current={inSettings ? "page" : undefined}
        aria-expanded={inSettings}
      >
        <Settings aria-hidden="true" width={15} height={15} />
      </Link>
    </header>
  );
}

export { Kbd };

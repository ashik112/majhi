import { PAGE_LABEL, PAGE_PATH, PLACES, type Place, PRIVATE, PRIVATE_NAME } from "@majhi/shared";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, Search, Settings } from "lucide-react";
import { MajhiMark } from "@/components/ui/majhi-mark";
import { Menu } from "@/components/ui/menu";
import { isSettingsPath } from "@/features/settings/settings-frame";
import { useFeedLost } from "@/lib/feed-status";
import { MOD_KEY } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { AutonomousSwitch } from "./autonomous-switch";
import { NotificationBell } from "./bell";
import { useConsole } from "./data-context";
import { ConsoleLamp, Kbd, wsStyle } from "./parts";

/** How many workspaces get a button before the rest go under "N more". */
const SHOWN = 5;

function useWorkspaceChoices() {
  const { orgs } = useConsole();
  return [
    ...(orgs ?? []).filter((o) => o.id !== PRIVATE).map((o) => ({ id: o.id, name: o.name })),
    { id: PRIVATE, name: PRIVATE_NAME },
  ];
}

/** The workspace filter as buttons, from 1300 px up. */
function Workspaces() {
  const { hues, waitingByOrg } = useConsole();
  const { org, setOrg } = useOrgFilter();
  const all = useWorkspaceChoices();
  const several = all.length > SHOWN + 1;
  const shown = several ? all.slice(0, SHOWN) : all;
  // The picked workspace always shows, even when it would fall under "more".
  const picked = all.find((w) => w.id === org);
  if (picked !== undefined && !shown.includes(picked)) shown.push(picked);
  const rest = all.filter((w) => !shown.includes(w));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own box and legend
    <div className="cs-seg cs-ws-wide" role="group" aria-label="Workspace">
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

/** Below 1300 px the same filter is one select: "All workspaces". */
function WorkspaceSelect() {
  const { waitingByOrg } = useConsole();
  const { org, setOrg } = useOrgFilter();
  const all = useWorkspaceChoices();
  return (
    <label className="cs-ws-narrow">
      <span className="sr-only">Workspace</span>
      <select
        value={org ?? ""}
        onChange={(event) => setOrg(event.target.value === "" ? undefined : event.target.value)}
      >
        <option value="">All workspaces</option>
        {all.map((w) => {
          const waiting = waitingByOrg.get(w.id) ?? 0;
          return (
            <option key={w.id} value={w.id}>
              {w.name}
              {waiting > 0 ? ` (${waiting})` : ""}
            </option>
          );
        })}
      </select>
      <ChevronDown aria-hidden="true" width={12} height={12} />
    </label>
  );
}

/** Where the owner checks things every day, after the boat mark. */
function Places() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const on = (place: Place) =>
    place === "board"
      ? path === PAGE_PATH.board || path.startsWith("/t/")
      : path.startsWith(PAGE_PATH[place]);
  return (
    <nav className="cs-places" aria-label="Places">
      {PLACES.map((place) => (
        <Link
          key={place}
          to={PAGE_PATH[place]}
          search={{}}
          className="cs-place"
          aria-current={on(place) ? "page" : undefined}
        >
          {PAGE_LABEL[place]}
        </Link>
      ))}
    </nav>
  );
}

/** The bar above every screen: places, workspace filter, what needs the owner, search, Settings. */
export function TopBar({ onSearch }: { onSearch: () => void }) {
  const { counts } = useConsole();
  const lost = useFeedLost();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const inSettings = isSettingsPath(path);
  return (
    <header className="cs-top cs-glass">
      <Link to="/" className="cs-mark" aria-label="majhi: back to Home">
        <MajhiMark />
      </Link>
      <Places />
      <Workspaces />
      <WorkspaceSelect />
      {lost && (
        <div className="cs-conn" role="status">
          <ConsoleLamp state="paused" />
          Offline
        </div>
      )}
      <div className="cs-tele">
        {counts.incidents > 0 && (
          <>
            <Link to="/" search={{ pane: "needs" }} className="cs-inc cs-on" title="Open Needs you">
              <b>{counts.incidents}</b>
              {counts.incidents === 1 ? "incident" : "incidents"}
            </Link>
            <i />
          </>
        )}
        <Link
          to="/"
          search={{ pane: "needs" }}
          className={counts.needYou > 0 ? "cs-on" : undefined}
          title="Open Needs you"
        >
          <b>{counts.needYou}</b>need you
        </Link>
      </div>
      <AutonomousSwitch />
      <button type="button" className="cs-search" onClick={onSearch} aria-label="Search or ask">
        <Search aria-hidden="true" width={14} height={14} />
        Search or ask
        <span className="cs-kbd" style={{ marginLeft: "auto" }}>
          {MOD_KEY}K
        </span>
      </button>
      <NotificationBell />
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

import { collapseHome } from "@majhi/shared";
import { Link, Outlet } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useStudioShortcut } from "@/features/studio/use-studio-shortcut";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { useConfig, useHealth, useHostStatus } from "@/lib/queries";
import { useServerEvents } from "@/lib/use-server-events";

export function AppShell() {
  useServerEvents();
  useStudioShortcut();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-amber px-3 py-2 font-semibold text-amber-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <TopBar />
      <div id="main" className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}

function TopBar() {
  const config = useConfig();
  const state = config.data;
  const roots =
    state?.status === "loaded" ? state.config.workspaces.map((path) => collapseHome(path, state.home)) : [];

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
      <Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-md" aria-label="majhi, go to repos">
        <span
          aria-hidden="true"
          className="flex size-[26px] items-center justify-center rounded-[7px] bg-amber font-mono text-xs font-semibold text-amber-ink"
        >
          mj
        </span>
        <span className="text-md font-semibold tracking-[-0.01em]">majhi</span>
      </Link>
      {roots.length > 0 && (
        <Link
          to="/settings/roots"
          title={`Workspace roots: ${roots.join(", ")}. Click to edit.`}
          className="hidden min-w-0 items-center gap-2 overflow-hidden rounded-xs font-mono text-xs whitespace-nowrap text-fg-faint transition-colors hover:text-fg-muted sm:flex"
        >
          {roots.map((root, i) => (
            <span key={root} className="flex shrink-0 items-center gap-2">
              {i > 0 && <span aria-hidden="true" className="size-[3px] rounded-full bg-line-hover" />}
              {root}
            </span>
          ))}
        </Link>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link to="/studio/$tab" params={{ tab: "agents" }} search={{}} title={`Open Studio (${MOD_KEY} .)`}>
            Studio
            <Kbd aria-hidden="true">{MOD_KEY} .</Kbd>
          </Link>
        </Button>
        <OnlinePill />
      </div>
    </header>
  );
}

function OnlinePill() {
  const health = useHealth();
  const host = useHostStatus();
  const state = health.isPending ? "checking" : health.online ? "online" : "offline";
  const label = { checking: "Connecting", online: "Online", offline: "Offline" }[state];
  // Only a known "not connected" counts; while the status loads the pill stays as it is.
  const helperOff = state === "online" && host.data?.connected === false;
  const title =
    state === "online"
      ? `majhi ${health.data?.version ?? ""} is running.${helperOff ? " The host helper is not connected; make up installs it." : ""}`
      : state === "offline"
        ? "majhi is not answering. Start it with make up."
        : "Checking the server";

  return (
    <span
      role="status"
      title={title}
      className="flex h-8 items-center gap-[7px] rounded-full border border-line-strong px-3 text-sm text-fg-soft"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-[7px] rounded-full",
          state === "online" && "bg-green",
          state === "offline" && "bg-red",
          state === "checking" && "animate-shimmer bg-fg-faint",
        )}
      />
      <span>
        {label}
        {helperOff && <span className="text-fg-faint">, helper off</span>}
      </span>
    </span>
  );
}

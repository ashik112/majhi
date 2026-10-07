import { Lamp } from "@/components/ui/lamp";
import { useBoss } from "@/features/boss/boss-context";
import { useLogEntries } from "@/features/captain/log";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { formatAgo } from "@/lib/format";
import { useNow } from "@/lib/use-now";

/** What the captain did last and whether it works: the ticker draws it, the sidebar's Captain row hints it. */
function useCaptainLast() {
  const status = useAutonomyStatus().data;
  // What the captain did, not that it was woken; a wake-up only when nothing else happened yet.
  const done = useLogEntries("", "all", true).entries;
  const all = useLogEntries("", "all", false).entries;
  const now = useNow(15_000);
  const last = done[0] ?? all[0];
  const working =
    status !== undefined && (status.boss?.working === true || status.lanes.some((l) => l.working));
  const lane = last?.org === undefined ? undefined : status?.lanes.find((l) => l.org === last.org);
  return { status, working, last, lane, now };
}

/** The captain's last line as one sentence, for a tooltip. Undefined until the status is known. */
export function useCaptainTitle(): string | undefined {
  const { status, working, last, lane, now } = useCaptainLast();
  if (status === undefined) return undefined;
  const off = status.mode === "off" ? " Auto-pilot is off." : "";
  if (last === undefined) return `${working ? "Working." : "Nothing yet today."}${off}`;
  return `${formatAgo(last.at, now)}${lane === undefined ? "" : `, ${lane.name}`}: ${last.sentence}${off}`;
}

/**
 * One line on the Captain page: what the captain did last, where and when, with a lamp
 * while it works. Clicking it opens the captain's All chat, where every workspace thread reports as it lands.
 */
export function CaptainTicker() {
  const { show } = useBoss();
  const { status, working, last, lane, now } = useCaptainLast();
  if (status === undefined) return null;
  return (
    <button
      type="button"
      onClick={() => show("talk")}
      title="Open the captain's All chat"
      className="mb-2 flex h-8 w-full min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-line bg-glass px-3 text-left text-sm text-fg-muted transition-colors hover:border-line-hover hover:text-fg"
    >
      <Lamp state={working ? "working" : "idle"} size={6} />
      <span className="shrink-0 font-medium text-fg">Captain</span>
      {last === undefined ? (
        <span className="truncate">
          {working ? "Working" : status.mode === "off" ? "Auto-pilot is off" : "Nothing yet today"}
        </span>
      ) : (
        <>
          <span className="shrink-0 font-mono text-xs text-fg-faint">{formatAgo(last.at, now)}</span>
          {lane !== undefined && <span className="shrink-0 text-fg-faint">{lane.name}</span>}
          <span className="min-w-0 truncate">{last.sentence}</span>
          {status.mode === "off" && (
            <span className="ml-auto shrink-0 text-xs text-fg-faint">Auto-pilot off</span>
          )}
        </>
      )}
    </button>
  );
}

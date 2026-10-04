import {
  DRAFT_STATUS_LABEL,
  OUTBOUND_CHANNEL_LABEL,
  OUTBOUND_MODE_LABEL,
  type OutboundMode,
} from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { PAGE_PATH } from "@/lib/pages";
import { useOutbound, useSetChannelMode } from "@/lib/playbook-queries";
import { useNow } from "@/lib/use-now";

const MODES: readonly OutboundMode[] = ["draft", "batch", "auto"];

const MODE_NOTE: Record<OutboundMode, string> = {
  draft: "You approve each one.",
  batch: "You approve a batch at a set hour.",
  auto: "Opens after the trust ladder is built.",
};

/**
 * The outbound gate (SPEC 5.18): how each channel sends in one workspace. Everything that would leave
 * the machine waits here first. Draft is the default; Auto is not offered yet.
 */
export function OutboundSheet({ org, onClose }: { org: string; onClose: () => void }) {
  const query = useOutbound(org);
  const set = useSetChannelMode();
  const toast = useToast();
  const now = useNow(60_000);
  const channels = query.data?.channels ?? [];
  const waiting = (query.data?.drafts ?? []).filter((d) => d.status === "pending" || d.status === "queued");
  const recent = (query.data?.drafts ?? [])
    .filter((d) => d.status !== "pending" && d.status !== "queued")
    .slice(0, 8);
  const change = (channel: (typeof channels)[number]["channel"], mode: OutboundMode, batchAt?: string) =>
    set.mutate(
      { org, channel, mode, ...(batchAt === undefined ? {} : { batchAt }) },
      { onError: (e) => toast("Could not change it", { detail: describeError(e), tone: "error" }) },
    );
  return (
    <Sheet title="Sending" subtitle="Nothing leaves this machine without passing here" onClose={onClose}>
      {query.isError ? (
        <p className="text-sm text-red">Could not load the channels: {describeError(query.error)}</p>
      ) : query.data === undefined ? (
        <RowsSkeleton rows={5} height={48} />
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col p-0">
            {channels.map((c) => (
              <li
                key={c.channel}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line py-2.5 first:border-t-0"
              >
                <div className="flex min-w-[150px] flex-1 flex-col">
                  <span className="text-base text-fg">{OUTBOUND_CHANNEL_LABEL[c.channel]}</span>
                  <span className="text-xs text-fg-faint">{MODE_NOTE[c.mode]}</span>
                </div>
                <fieldset
                  aria-label={`${OUTBOUND_CHANNEL_LABEL[c.channel]} mode`}
                  className="m-0 flex gap-1 rounded-[9px] border border-line-strong bg-field p-[3px]"
                >
                  {MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={c.mode === mode}
                      disabled={set.isPending || mode === "auto"}
                      title={mode === "auto" ? MODE_NOTE.auto : undefined}
                      onClick={() => change(c.channel, mode)}
                      className={cn(
                        "h-7 cursor-pointer rounded-md px-2.5 text-sm transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
                        c.mode === mode
                          ? "bg-selected text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]"
                          : "text-fg-muted hover:bg-raised hover:text-fg",
                      )}
                    >
                      {OUTBOUND_MODE_LABEL[mode]}
                    </button>
                  ))}
                </fieldset>
                {c.mode === "batch" && (
                  <label className="flex items-center gap-2 text-xs text-fg-muted">
                    At
                    <input
                      type="time"
                      aria-label={`${OUTBOUND_CHANNEL_LABEL[c.channel]} batch hour`}
                      defaultValue={c.batchAt}
                      onBlur={(e) =>
                        e.target.value !== "" &&
                        e.target.value !== c.batchAt &&
                        change(c.channel, "batch", e.target.value)
                      }
                      className="h-7 rounded-md border border-line-control bg-field px-2 text-sm text-fg"
                    />
                  </label>
                )}
              </li>
            ))}
          </ul>
          <section aria-label="Drafts" className="mt-4 border-t border-line pt-3">
            <div className="flex items-center gap-2">
              <h3 className="m-0 text-base font-semibold text-fg">Drafts</h3>
              {waiting.length > 0 && (
                <Button asChild size="sm" variant="secondary" className="ml-auto">
                  <Link to={PAGE_PATH.decisions} search={{}}>
                    {waiting.length} wait in Decisions
                  </Link>
                </Button>
              )}
            </div>
            {waiting.length === 0 && recent.length === 0 ? (
              <p className="m-0 mt-2 text-sm text-fg-muted">
                No drafts. What the captain writes for others waits here and in Decisions.
              </p>
            ) : (
              <ul className="m-0 mt-2 flex list-none flex-col p-0">
                {[...waiting, ...recent].map((d) => (
                  <li
                    key={d.id}
                    className="flex min-w-0 items-baseline gap-2.5 border-t border-line py-1.5 first:border-t-0"
                  >
                    <span className="w-[112px] shrink-0 text-xs text-fg-muted">
                      {DRAFT_STATUS_LABEL[d.status]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-fg-soft" title={d.result ?? d.body}>
                      {OUTBOUND_CHANNEL_LABEL[d.channel]} to {d.target}
                    </span>
                    <span className="tnum shrink-0 font-mono text-xs text-fg-faint">
                      {formatAgo(d.createdAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Sheet>
  );
}

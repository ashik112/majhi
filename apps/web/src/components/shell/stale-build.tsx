import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStaleBuild } from "@/lib/build-watch";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/**
 * Shown when majhi was updated while this tab was open and a composer holds unsent text. With nothing
 * unsent the tab has reloaded already, and with the text sent it reloads by itself.
 */
export function StaleBuildBar() {
  const { decision, reload } = useStaleBuild();
  if (decision === "none") return null;
  return (
    <section
      aria-label="Update"
      className={cn("mb-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-2", GLASS)}
    >
      <RefreshCw aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <p className="min-w-0 flex-1 text-base text-fg-soft">majhi was updated. Reload to use the new version.</p>
      <Button size="sm" variant="primary" onClick={reload}>
        Reload
      </Button>
    </section>
  );
}

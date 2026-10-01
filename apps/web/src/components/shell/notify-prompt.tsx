import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/lib/boss-queries";
import { useNotifyPrompt } from "@/lib/browser-notify";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/**
 * A small strip above the banner that asks once for the browser's permission to notify. The browser
 * only allows the request from a click, so nothing is asked on load. It never shows once the owner
 * answered the browser or pressed Not now, or when browser notifications are off in setup.
 */
export function NotifyPrompt() {
  const settings = useSettings().data;
  const prompt = useNotifyPrompt(settings?.notifications.browser === true);
  if (!prompt.show) return null;
  return (
    <section
      aria-label="Notifications"
      className={cn("mb-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-2", GLASS)}
    >
      <Bell aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <p className="min-w-0 flex-1 text-base text-fg-soft">
        Get a notification when an agent needs you, even when this tab is in the background.
      </p>
      <Button size="sm" variant="primary" onClick={prompt.enable}>
        Turn on
      </Button>
      <Button size="sm" variant="ghost" onClick={prompt.dismiss}>
        Not now
      </Button>
    </section>
  );
}

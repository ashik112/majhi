import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useSaveSettings, useSettings } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";

/** A whole number from `min` to `max`, or undefined. */
function parseWhole(text: string, min: number, max: number): number | undefined {
  const value = Number(text.trim());
  return /^[0-9]+$/.test(text.trim()) && value >= min && value <= max ? value : undefined;
}

/**
 * When majhi frees disk in done tasks: after how many hours it deletes dependency folders and build
 * output, and after how many days it removes a clean, merged or pushed worktree whole.
 */
export function FreeSpaceSettings() {
  const settings = useSettings();
  const save = useSaveSettings();
  const toast = useToast();
  const hours = settings.data?.cleanup.free_after_hours;
  const days = settings.data?.cleanup.worktree_after_days;
  const [hoursText, setHoursText] = useState<string>();
  const [daysText, setDaysText] = useState<string>();
  const hoursField = hoursText ?? (hours === undefined ? "" : String(hours));
  const daysField = daysText ?? (days === undefined ? "" : String(days));
  const nextHours = parseWhole(hoursField, 1, 8760);
  const nextDays = parseWhole(daysField, 0, 3650);

  return (
    <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2 text-sm text-fg-soft">
      <span className="font-medium text-fg">Free space</span>
      <label htmlFor="free-hours">Delete node_modules and build output after</label>
      <Input
        id="free-hours"
        inputMode="numeric"
        value={hoursField}
        aria-invalid={nextHours === undefined ? true : undefined}
        onChange={(event) => setHoursText(event.target.value)}
        className="h-8 w-16 text-center"
      />
      <span>hours done.</span>
      <label htmlFor="free-days">Remove clean worktrees after</label>
      <Input
        id="free-days"
        inputMode="numeric"
        value={daysField}
        aria-invalid={nextDays === undefined ? true : undefined}
        onChange={(event) => setDaysText(event.target.value)}
        className="h-8 w-16 text-center"
      />
      <span>days (0 is off).</span>
      {nextHours !== undefined && nextDays !== undefined && (nextHours !== hours || nextDays !== days) && (
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() =>
            save.mutate(
              { cleanup: { free_after_hours: nextHours, worktree_after_days: nextDays } },
              {
                onSuccess: () => {
                  setHoursText(undefined);
                  setDaysText(undefined);
                  toast("Free space settings saved");
                },
                onError: (e) => toast("Could not save", { detail: describeError(e), tone: "error" }),
              },
            )
          }
        >
          Save
        </Button>
      )}
    </div>
  );
}

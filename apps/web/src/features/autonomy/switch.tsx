import type { AutonomyStatus } from "@majhi/shared";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { Switch } from "@/components/ui/switch";
import { autonomyMissing, useAutonomyStatus } from "@/lib/autonomy-queries";
import { useCaptainCommand, useCaptainStatus } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { OffDialog, TurnOnDialog } from "./controls";
import { capTone, MODE_LAMP, MODE_WORD, todayLine } from "./model";

const SPEND_TONE = { calm: "text-fg-faint", amber: "text-amber", red: "text-red" } as const;

/** Today's autonomous spend against the day budget, in the tone of how much is used. */
export function SpendToday({ status, className }: { status: AutonomyStatus; className?: string }) {
  const total = status.spend.total;
  const tone = capTone(total);
  return (
    <span
      title="What Auto-pilot spent today against its day budget. Tasks you start yourself are not counted here; a task's own cost counts all its turns."
      className={cn("tnum truncate", SPEND_TONE[tone], className)}
    >
      {tone === "red" ? "Budget used up: " : "Auto-pilot spent "}
      {todayLine(total)}
    </span>
  );
}

/**
 * Stop everything: halts all captain work in every workspace, separate from Auto-pilot, until it is pressed
 * again. Owner-started agent runs keep their own controls.
 */
function StopEverything() {
  const status = useCaptainStatus().data;
  const stop = useCaptainCommand("captain.stop");
  const resume = useCaptainCommand("captain.resume");
  const stopped = status?.stopped === true;
  const busy = stop.isPending || resume.isPending;
  return (
    <span className="flex items-center gap-2">
      {stopped && (
        <span role="status" className="flex items-center gap-1.5 text-sm text-red">
          <Lamp state="needs" size={7} />
          Stopped
        </span>
      )}
      <Button
        size="sm"
        variant={stopped ? "primary" : "secondary"}
        disabled={status === undefined || busy}
        title={
          stopped
            ? "The captain does nothing until you resume it"
            : "Halt all captain work in every workspace, until you press again"
        }
        onClick={() =>
          stopped
            ? resume.mutate({ input: {}, reason: "Owner resumed the captain" })
            : stop.mutate({ input: {}, reason: "Owner pressed Stop everything" })
        }
      >
        {stopped ? "Resume" : "Stop everything"}
      </Button>
    </span>
  );
}

/**
 * The one Auto-pilot switch: On or Off, opening the dialog for the change. The switch needs a
 * loaded status; `children` receives what it shows and the switch itself, so the sidebar and the
 * Captain page lay it out their own way.
 */
export function useAutonomousSwitch(): {
  status: AutonomyStatus | undefined;
  unavailable: string | undefined;
  mode: AutonomyStatus["mode"];
  toggle: ReactNode;
  dialogs: ReactNode;
} {
  const query = useAutonomyStatus();
  const status = query.data;
  const [open, setOpen] = useState<"on" | "off">();
  const mode = status?.mode ?? "off";
  const unavailable = query.isError
    ? autonomyMissing(query.error)
      ? "Auto-pilot is not ready on this server yet"
      : "Could not read Auto-pilot"
    : undefined;
  return {
    status,
    unavailable,
    mode,
    toggle: (
      <span className="flex items-center gap-3">
        <Switch
          label="Auto-pilot"
          hideLabel
          checked={mode !== "off"}
          disabled={status === undefined}
          title={unavailable ?? (mode === "off" ? "Turn Auto-pilot on" : "Turn Auto-pilot off")}
          onChange={(next) => setOpen(next ? "on" : "off")}
        />
        <StopEverything />
      </span>
    ),
    dialogs: (
      <>
        {open === "on" && status && <TurnOnDialog status={status} onClose={() => setOpen(undefined)} />}
        {open === "off" && status && <OffDialog status={status} onClose={() => setOpen(undefined)} />}
      </>
    ),
  };
}

/** The switch for a page header: lamp, word, today's spend and the switch. */
export function AutonomousSwitch() {
  const { status, unavailable, mode, toggle, dialogs } = useAutonomousSwitch();
  const lamp = MODE_LAMP[mode];
  return (
    <div title={unavailable} className="flex min-w-0 shrink-0 items-center gap-3">
      <div className="flex min-w-0 flex-col items-end leading-tight">
        <span className="flex items-center gap-1.5 text-base font-medium text-fg">
          <Lamp state={lamp} size={7} />
          Auto-pilot
          <span className={cn("text-sm font-normal", LAMP_TEXT[lamp])}>{MODE_WORD[mode]}</span>
        </span>
        {status && <SpendToday status={status} className="max-w-[220px] text-xs" />}
      </div>
      {toggle}
      {dialogs}
    </div>
  );
}

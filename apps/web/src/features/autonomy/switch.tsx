import type { AutonomyStatus } from "@majhi/shared";
import { type ReactNode, useState } from "react";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { Switch } from "@/components/ui/switch";
import { autonomyMissing, useAutonomyStatus } from "@/lib/autonomy-queries";
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
      title="Autonomous spend today against its day budget"
      className={cn("tnum truncate", SPEND_TONE[tone], className)}
    >
      {tone === "red" ? "Budget used up: " : ""}
      {todayLine(total)}
    </span>
  );
}

/**
 * The one Autonomous switch: On or Off, opening the dialog for the change. The switch needs a
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
      ? "Autonomous is not ready on this server yet"
      : "Could not read Autonomous"
    : undefined;
  return {
    status,
    unavailable,
    mode,
    toggle: (
      <Switch
        label="Autonomous"
        hideLabel
        checked={mode !== "off"}
        disabled={status === undefined}
        title={unavailable ?? (mode === "off" ? "Turn Autonomous on" : "Turn Autonomous off")}
        onChange={(next) => setOpen(next ? "on" : "off")}
      />
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
          Autonomous
          <span className={cn("text-sm font-normal", LAMP_TEXT[lamp])}>{MODE_WORD[mode]}</span>
        </span>
        {status && <SpendToday status={status} className="max-w-[220px] text-xs" />}
      </div>
      {toggle}
      {dialogs}
    </div>
  );
}

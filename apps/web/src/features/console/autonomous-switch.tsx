import type { AutonomyStatus } from "@majhi/shared";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { useAutonomyCommand, useAutonomyStatus } from "@/lib/autonomy-queries";
import { useCaptainCommand, useCaptainStatus } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { clockWord, type UntilChoice, untilOf } from "./autonomous-until";
import { ConsoleLamp } from "./parts";

/** The one line under the switch: what Autonomous is doing, what it spent today and when it ends. */
export function statusLine(status: AutonomyStatus, now: Date): string {
  if (status.mode === "stopping") return "Turning off after the current turns";
  if (status.mode === "off") return "Works only when asked";
  const total = status.spend.total;
  const cap = total.cap?.cost;
  const spent =
    cap === undefined
      ? formatMoney(total.used.cost)
      : `${formatMoney(total.used.cost)} of ${formatMoney(cap)}`;
  const working = `${status.running.length} working`;
  const until =
    status.until === undefined ? "until you turn it off" : `until ${clockWord(new Date(status.until), now)}`;
  return `${working} · ${spent} today · ${until}`;
}

/** Each way to end it, said to turn it on and said to change the end of a switch that is on. */
const CHOICES: readonly { choice: UntilChoice; label: string; ends: string }[] = [
  { choice: "manual", label: "Until I turn it off", ends: "When I turn it off" },
  { choice: "morning", label: "Until 8:00", ends: "At 8:00" },
  { choice: "tonight", label: "Until tonight", ends: "Tonight" },
  { choice: "two-hours", label: "For 2 hours", ends: "In 2 hours" },
];

/**
 * The Autonomous switch in the top bar: on or off, with an end time, and Pause all under it. One control; the
 * status line says what it is doing. Reading and answering never depend on it.
 */
export function AutonomousSwitch() {
  const toast = useToast();
  const status = useAutonomyStatus().data;
  const captain = useCaptainStatus().data;
  const start = useAutonomyCommand("autonomy.start");
  const stop = useAutonomyCommand("autonomy.stop");
  const halt = useCaptainCommand("captain.stop");
  const lift = useCaptainCommand("captain.resume");
  if (status === undefined) return null;
  const now = new Date();
  const paused = captain?.stopped === true;
  const failed = (what: string) => ({
    onError: (error: Error) => toast(what, { detail: describeError(error), tone: "error" }),
  });
  const turnOn = (choice: UntilChoice) =>
    start.mutate(
      {
        input: { until: untilOf(choice, now) },
        reason: "Owner turned Autonomous on",
      },
      failed("Could not turn Autonomous on"),
    );
  const busy = start.isPending || stop.isPending || halt.isPending || lift.isPending;
  const items: MenuItem[] = [
    ...(status.mode === "off"
      ? CHOICES.map((c) => ({
          group: "Turn on",
          label: c.label,
          disabled: busy,
          onSelect: () => turnOn(c.choice),
        }))
      : status.mode === "on"
        ? [
            ...CHOICES.map((c) => ({
              group: "Ends",
              label: c.ends,
              disabled: busy,
              onSelect: () => turnOn(c.choice),
            })),
            {
              group: "Now",
              label: "Turn off",
              disabled: busy,
              onSelect: () =>
                stop.mutate(
                  { input: {}, reason: "Owner turned Autonomous off" },
                  failed("Could not turn Autonomous off"),
                ),
            },
          ]
        : [{ group: "Now", label: "Turning off", disabled: true, onSelect: () => undefined }]),
    {
      group: "Pause all",
      label: paused ? "Resume all" : "Pause all",
      disabled: busy,
      onSelect: () =>
        paused
          ? lift.mutate({ input: {}, reason: "Owner resumed the captain" }, failed("Could not resume"))
          : halt.mutate({ input: {}, reason: "Owner pressed Pause all" }, failed("Could not pause")),
    },
  ];
  const word = paused
    ? "Paused"
    : status.mode === "on"
      ? "On"
      : status.mode === "stopping"
        ? "Turning off"
        : "Off";
  return (
    <Menu
      label="Autonomous"
      align="right"
      items={items}
      trigger={(t) => (
        <button type="button" className="cs-auto" {...t}>
          <ConsoleLamp state={paused ? "paused" : status.mode === "on" ? "working" : "idle"} />
          <span className="cs-t">
            <b>Autonomous · {word}</b>
            <small>{paused ? "Nothing the captain does runs" : statusLine(status, now)}</small>
          </span>
        </button>
      )}
    />
  );
}

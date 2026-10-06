import type { DiagramEdgeType } from "@majhi/shared";
import { EDGE_PRESETS } from "@/features/diagram/presets";

/** The arrow of a line, in the color and dash of its kind; a guess is dotted. */
export function TalkArrow({
  type,
  guessed,
  reversed = false,
}: {
  type: DiagramEdgeType | undefined;
  guessed: boolean;
  reversed?: boolean;
}) {
  const color = type === undefined ? "var(--c-fg-muted)" : EDGE_PRESETS[type].color;
  const dash = guessed ? "2 3" : type === undefined ? undefined : EDGE_PRESETS[type].dash;
  return (
    <svg
      width="26"
      height="8"
      viewBox="0 0 26 8"
      aria-hidden="true"
      className="shrink-0 overflow-visible"
      style={reversed ? { transform: "scaleX(-1)" } : undefined}
    >
      <path d="M0 4H22" stroke={color} strokeWidth="1.6" strokeDasharray={dash} fill="none" />
      <path d="M26 4l-5-3v6z" fill={color} />
    </svg>
  );
}

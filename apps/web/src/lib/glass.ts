/**
 * The glass material, as Tailwind classes so a caller's `className` can override any part through `cn`.
 * A translucent fill that blurs the grid behind it, a 1px hairline, a highlight along the top edge
 * and a soft offset shadow.
 *
 * GLASS is for resting surfaces (the sidebar, the top bars, cards, the room's dock); GLASS_STRONG is
 * for what floats over content (menus, dialogs, drawers), where the text behind must not show through.
 */
export const GLASS =
  "border border-glass-line bg-glass shadow-glass backdrop-blur-[18px] backdrop-saturate-[1.35]";

export const GLASS_STRONG =
  "border border-glass-line bg-glass-strong shadow-pop backdrop-blur-[24px] backdrop-saturate-[1.4]";

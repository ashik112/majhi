---
name: majhi
description: A flight director's console for agent work. Glass panels over a radar grid, one situation board read at a glance.
colors:
  base: "#050a13"
  canvas: "#0a0f17"
  glass: "rgb(12 18 28 / 0.6)"
  glass-strong: "rgb(13 19 30 / 0.975)"
  card: "rgb(18 26 39 / 0.58)"
  field: "rgb(5 9 16 / 0.55)"
  sunken: "rgb(3 6 11 / 0.62)"
  raised: "rgb(130 175 230 / 0.075)"
  selected: "rgb(130 185 245 / 0.14)"
  glass-line: "rgb(80 190 235 / 0.2)"
  hair: "rgb(90 200 240 / 0.28)"
  grid: "rgb(110 160 215 / 0.06)"
  grid-major: "rgb(110 170 230 / 0.1)"
  ring: "rgb(90 195 240 / 0.15)"
  line: "rgb(140 185 240 / 0.1)"
  line-strong: "rgb(140 185 240 / 0.14)"
  line-control: "rgb(150 195 245 / 0.22)"
  line-bright: "rgb(150 195 245 / 0.28)"
  line-hover: "rgb(165 205 250 / 0.4)"
  fg: "#e7edf5"
  fg-soft: "#c2ccd9"
  fg-muted: "#9da9b9"
  fg-faint: "#828fa1"
  fg-dim: "#5a6778"
  accent: "#f0b455"
  accent-hover: "#f5c273"
  accent-press: "#e0a444"
  accent-ink: "#1a1204"
  accent-wash: "rgb(240 180 85 / 0.12)"
  accent-line: "rgb(240 180 85 / 0.38)"
  accent-text: "#f3c47a"
  brand: "#f0b455"
  brand-ink: "#1a1204"
  caution: "#f0b455"
  caution-wash: "rgb(240 180 85 / 0.1)"
  caution-line: "rgb(240 180 85 / 0.32)"
  blue: "#8ab8f5"
  green: "#7fd1b9"
  red: "#f07b6b"
  violet: "#c3a6f5"
  lamp-working: "#3fd4f5"
  lamp-needs: "#ff6868"
  lamp-paused: "#ee72dc"
  lamp-done: "#45d99a"
  lamp-idle: "#5f6d80"
typography:
  headline:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: "26px"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: "1.375rem"
  card-title:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.35
  body:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  label:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1.125rem"
  group-label:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0.08em"
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: "1rem"
    fontFeature: "tnum"
  telemetry:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: "1.375rem"
    fontFeature: "tnum"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  2xl: "14px"
  full: "9999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "2.5": "10px"
  "3": "12px"
  "3.5": "14px"
  "4": "16px"
  "5": "20px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-primary-active:
    backgroundColor: "{colors.accent-press}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "34px"
  button-secondary-hover:
    backgroundColor: "{colors.selected}"
  button-ghost:
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "34px"
  button-ghost-hover:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "34px"
  glass-panel:
    backgroundColor: "{colors.glass}"
    rounded: "{rounded.2xl}"
  task-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.fg}"
    rounded: "{rounded.xl}"
    padding: "12px"
  choice-chip:
    backgroundColor: "{colors.card}"
    textColor: "{colors.fg-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "34px"
  choice-chip-pressed:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.fg}"
  segment:
    textColor: "{colors.fg-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  segment-pressed:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.fg}"
  badge:
    textColor: "{colors.fg-muted}"
    typography: "{typography.data}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "20px"
  nav-item:
    textColor: "{colors.fg-muted}"
    typography: "{typography.card-title}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  nav-item-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.fg}"
  lamp:
    backgroundColor: "{colors.lamp-working}"
    rounded: "{rounded.full}"
    size: "8px"
---

# Design System: majhi

## Overview

**Creative North Star: "The Flight Director's Console"**

majhi is a console, not a document. The owner runs agent teams across orgs all day on a desktop, and the whole app is one fixed instrument panel: blue-black glass panels frosted over a faint radar grid, cyan hairlines where one region meets another, and round status lamps that say what runs, what needs the owner, and what waits. The viewport is the console. The document never scrolls; every list scrolls inside its own panel and fades at its edges, so a row meets the glass softly instead of being cut mid-line.

Density is instrument-grade: a 13px base, a five-step type ramp that tops out at 22px, and numbers set in IBM Plex Mono with tabular figures so counts line up and never jitter. The palette is a dark blue-black ground with near-neutral cool text; colour is spent almost entirely on signal. Five lamp colours carry state and nothing else, and one pickable accent (amber by default, matching the brand mark) carries action and current selection. Dark is the default theme; light is pale instrument glass on a cool gray grid, with every token re-tuned rather than inverted. A System choice follows the operating system.

The world rejects the flat gray card stack with "Nothing here" boxes: an empty column is not a box, it is a slim rail with its name and count.

**Key Characteristics:**
- Fixed-viewport shell: glass sidebar (228px), glass top telemetry strip, status columns and a roster, 12px gaps and 12px outer padding.
- Two glass weights: translucent resting glass, near-opaque floating glass.
- Round status lamps in five fixed colours, always with a word beside them.
- Mono only for numbers, ids, handles, paths and data.
- Pickable accent (amber, blue, violet, lime, steel) that never sits on a lamp hue.
- Theme and accent applied before first paint from the saved choice.

## Colors

A blue-black instrument ground with cool neutral text, five reserved lamp colours for state, and one pickable accent for action.

### Primary
- **Brand Amber accent** (`accent`): primary buttons, focus outlines, text caret, text selection highlight and pressed choice chips. It never marks the selected row; that is the selected tint (see Navigation). It is the default of five accents; the owner can switch to Radar Blue (#7ea6ff), Plotter Violet (#a98bf5), Signal Lime (#b6dc4e) or Instrument Steel (#b8c4d6). Each accent ships a full set (hover, press, ink, wash, line, text) per theme. Accent-text is the variant used for type on glass; accent-ink is the text on a filled accent.
- **Mark Amber** (`brand`): the `mj` mark only. It stays amber in every theme and accent.

### Secondary: Status Lamps
- **Working Cyan** (`lamp-working`): an agent is working. Breathes (2.2s glow pulse).
- **Needs-You Red** (`lamp-needs`): the task waits for the owner (review, your turn). Steady glow ring.
- **Paused Magenta** (`lamp-paused`): stopped by usage limit, offline, error, or by the owner. Steady glow ring.
- **Done Green** (`lamp-done`): finished or shipped (MR open, done). Plain lit dot.
- **Idle Slate** (`lamp-idle`): inbox, ready, nobody on it. Unlit 1.5px ring. Idle text uses `fg-faint`, since the idle lamp is too dim to read.

### Tertiary: Messages and Caution
- **Caution Amber** (`caution`): warnings and approvals, with wash and line variants for badges and notices.
- **Message Blue, Green, Red, Violet** (`blue`, `green`, `red`, `violet`): identity, badge tones, links (blue), @mentions (violet), allowed toggles (green wash), errors and invalid fields (red), and syntax highlighting (plus coral and pink). These are softer, lower-chroma than the lamps and never stand in for a lamp.

### Neutral
- **Radar Ground** (`base`): the backdrop behind everything; the grid, rings and glows sit on it.
- **Console Glass** (`glass`): resting panels (sidebar, top bars, columns frame, roster, cards' material). 60% fill, 18px blur.
- **Floating Glass** (`glass-strong`): menus, dialogs, drawers. 97.5% fill so text behind never shows through.
- **Card Glass** (`card`), **Field Well** (`field`), **Sunken Well** (`sunken`): task cards, inputs and segmented tracks, code wells.
- **Raised / Selected tints** (`raised`, `selected`): hover and pressed fills; translucent blue-white, never gray.
- **Cyan Hairline** (`hair`, `glass-line`): panel borders and the column-head rule that fades from left to 85%.
- **Line ladder** (`line` < `line-strong` < `line-control` < `line-bright` < `line-hover`): dividers, card borders, control borders, scrollbar thumb, hover borders.
- **Text ladder** (`fg` < `fg-soft` < `fg-muted` < `fg-faint` < `fg-dim`): primary text, body text, secondary, labels and counts, disabled and code comments.
- **Grid, Grid Major, Ring** (`grid`, `grid-major`, `ring`): the radar backdrop only: a 32px grid, a 160px major grid, 160px rings centred at 72% / 58% and faint crosshairs.

Light theme re-tunes every token (ground #e5eaf0, text #0e1726, lamps darkened to #0a7694 / #cf2a2a / #a52a93 / #0b8058 / #8d99a9, amber accent #e39a2b with #8f5406 text). The light scope and horizon glows are transparent; the grid and rings stay. Values live in `apps/web/src/styles.css` and the sidecar.

### Named Rules
**The Lamp Law Rule.** One colour per state, the same on the board, in rooms and in the sidebar, and the saturated lamp values are used for nothing else. Status text in a lamp colour, a lit card frame, a count beside a lit column: all state. Buttons, links, badges and charts use the accent or the message palette.

**The Between-the-Lamps Rule.** Accents sit between the lamps on the colour wheel, never on one. A new accent must not be read as cyan, red, magenta or green.

**The Word Beside the Lamp Rule.** A lamp colour never carries meaning alone. Every lamp has its state word, label or count beside it; lamps themselves are `aria-hidden`.

**The Material Cyan Rule.** The glass world's own cyan (hairlines, panel edges, grid, rings) is material, not signal: it stays low-alpha (0.06 to 0.3). Only the full-strength `lamp-working` means "working".

## Typography

**Display Font:** none; the console has no display tier.
**Body Font:** IBM Plex Sans (with Helvetica Neue, system-ui)
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, SF Mono, Menlo)

**Character:** An engineering pair from one family. Plex Sans carries words at small sizes with no ceremony; Plex Mono carries every number, id and handle like a readout.

### Hierarchy
- **Headline** (600, 22px, 26px, -0.01em): the page title in the top bar ("Board"). One per page.
- **Title** (600, 15px, 22px): card and dialog headings, empty-state headings. Column heads use 600 at 13px.
- **Card title** (500, 14px, 1.35): task titles on cards (clamped to three lines), sidebar navigation, agent message body (14px, 1.6).
- **Body** (400, 13px, 20px): the default everywhere; controls and inputs.
- **Label** (400, 12px, 18px): secondary lines, chips, segments, lamp status lines.
- **Group label** (500, 11px, 0.08em, uppercase, `fg-faint`): the heading of a group or the column heads of a table ("Orgs", "Agents right now", "Accounts"). Never above a title.
- **Data** (Plex Mono 400, 11 to 13px, tabular): task ids, agent handles, counts, percentages, paths, keyboard hints.
- **Telemetry** (Plex Mono 500, 15px, tabular): the big numbers in the top telemetry strip, with the word in Sans beside each.

Documents in the file viewer step up to 15px at 1.65 with headings at 1.55em and 1.28em over a hairline.

### Named Rules
**The Mono Is Data Rule.** Mono is only for numbers, ids, handles, paths, code and data. Prose, labels and titles are always Sans.

**The Tabular Count Rule.** Every count, time and percentage that can change is tabular (`tnum`), so it lines up and does not jitter while it ticks.

## Layout

The shell is the viewport (`100dvh`, overflow hidden, no overscroll). Inside it: a 12px outer padding and 12px gaps between regions. The sidebar is a 228px glass column with the brand, navigation, org filter and, pinned at its foot, the "Agents right now" lamp grid. The main area stacks a glass top bar (min 68px, 14px corners) above the working region.

On the board, status columns share the width (min 228px each) with 12px gaps and scroll vertically inside themselves. Columns with no cards, and Done while folded, collapse to 44px rails: dashed border, lamp, the column name set vertically and the count in mono. The agent roster sits at the right as a glass panel. At narrower widths (checked at 1100px) the columns keep their minimum and the row scrolls horizontally inside the board, never the page; the telemetry strip tightens its gap below 1280px.

Spacing runs on a 4px base with half steps: 8px is the dominant gap, then 6, 4, 12 and 10. Card padding is 12px; panel padding 16px by 14px; top bar 20px left inset.

### Named Rules
**The Fixed Console Rule.** The document never scrolls. Every region that can overflow scrolls inside itself with `overscroll-behavior: contain` and edge fades.

**The Edge Fade Rule.** Scroll areas fade 22px at an edge only while there is more to scroll that way (scroll-driven; static fades where unsupported). Areas with a sticky header fade only the bottom.

**The Rail Rule.** An empty column is never an empty box. It collapses to a slim dashed rail with its lamp, vertical name and count.

## Elevation & Depth

Depth is glass over a backdrop, not stacked paper. The backdrop is layered: base colour, a low horizon glow, a cool glow top left, an accent-tinted glow bottom right, a 32px grid, a 160px major grid, radar rings and crosshairs. Glass surfaces blur and saturate it (18px blur and 1.35 saturate at rest; 24px and 1.4 floating) and carry a 1px cyan-tinted hairline, a 1px inner highlight along the top edge, and a soft, low, diffuse shadow. Dialogs sit over a scrim with a 3px blur and enter with a 6px rise, a slight scale and a 2px blur clearing.

### Shadow Vocabulary
- **Glass rest** (`inset 0 1px 0 0 var(--c-glass-hi), 0 14px 34px -16px rgb(0 0 0 / 0.75), 0 3px 8px -4px rgb(0 0 0 / 0.5)`): every resting glass surface and task card.
- **Pop** (`inset 0 1px 0 0 var(--c-glass-hi), 0 24px 56px -18px rgb(0 0 0 / 0.85), 0 6px 16px -6px rgb(0 0 0 / 0.55)`): floating glass, and a task card on hover.
- **Lamp glow** (`0 0 0 3px` of 16% lamp colour plus `0 0 9px` of 55%): needs-you and paused lamps. Working breathes between 8px and 12px glow.
- **Accent halo** (`0 6px 18px -8px var(--c-accent)`): under the primary button only. The mark carries a matching small glow.

### Named Rules
**The Two Glass Rule.** Resting surfaces use translucent glass; anything that floats over content (menus, dialogs, drawers, popovers) uses the near-opaque floating glass, because a popover inside a panel cannot blur what lies outside that panel.

**The Lit Frame Rule.** A card in a lit state (working, needs you, paused) carries its lamp in the frame: the border tinted to 30 to 35% of the lamp colour and a 7 to 8% wash fading from the top edge. Done and idle cards stay plain.

## Shapes

Soft instrument corners, nested so the outer frame is always the roundest: shell panels and rails 14px, cards and dialogs 12px, panels 10px, controls, inputs and nav rows 8px, badges 6px, inline code and small links 4px. Lamps and avatars are full circles. Borders are 1px hairlines throughout and go all the way round; the only dashed border is the collapsed column rail. The column head closes with a 1px hairline that fades out to the right.

### Named Rules
**The No Edge Bars Rule.** Selection and state are never marked by a bar, stripe or coloured border on one edge of a row, card, callout or panel. Selection is a filled tint with a ring all round; state is a lamp with its word, or a tinted frame on every side (the Lit Frame Rule).

## Components

### Buttons
Quiet and exact: colour moves, nothing jumps.
- **Shape:** gently rounded (8px); heights 28, 34 (default), 40 and 44px; icon buttons 28 and 32px square.
- **Primary:** accent fill, accent-ink text, semibold, with the accent halo. Hover and press step to the accent's hover and press values.
- **Secondary (default):** raised tint, `line-control` border, `fg` text; hover brightens the border and moves to the selected tint.
- **Ghost:** no fill, `fg-muted` text; hover gains the raised tint and full text colour.
- **Focus / Disabled:** 2px accent outline at 2px offset; disabled drops to 45% opacity. Transitions are 150ms on colour only.

### Chips
- **Choice chip:** 34px min height, 8px corners, card fill, `line-strong` border, muted text. Pressed: accent wash and accent line with full text; `aria-pressed` carries the state. Can set its content in mono for ids.
- **Allowed state:** green wash and green line for toggles that mean "on".

### Segmented switch
A 3px-inset track (9px corners, field fill, `line-strong` border) holding 32px segments. The pressed segment gets the selected tint and a 1px inset `line-control` ring. Counts follow the label in mono, `fg-faint`.

### Cards / Containers
- **Task card:** 12px corners, card glass with 12px blur, `glass-line` border, glass rest shadow, 12px padding, 8px internal gap. Top row: lamp, org tile, id in mono, parent link, team avatars. Then the title (card title role, three lines max), a status line in the lamp's colour, and a 3px progress bar or, while working, a 3px track with a cyan sweep. Hover lifts 1px, brightens the border and moves to the pop shadow. Cards rise in with a 30ms stagger (capped at eight).
- **Glass panel / Card:** glass material; 10px corners (panel) or 12px with 16px by 14px padding (page card).
- **Badge:** 20px tall, 6px corners, 1px border, 11px text; tones neutral, caution, blue, green, red; mono for ids.

### Inputs / Fields
- **Style:** 34px tall, 8px corners, field fill, `line-control` border, 13px text, accent caret, `fg-faint` placeholder.
- **Focus:** the border turns accent; no ring on top.
- **Error / Disabled:** red border (also on focus); disabled at 50% opacity.

### Navigation and selection
The sidebar navigation is a stack of 32px rows (14px, medium), muted at rest, raised tint on hover. Counts sit right-aligned in mono. Group labels head the org list and the lamp grid.

One selection treatment everywhere (sidebar pages, the sidebar org filter, the rows of every list-and-detail page, pressed segments): the `selected` tint, a 1px inset `line-control` ring all round, and full `fg` text, medium weight where the row's text is otherwise regular. It is `ROW_SELECTED` in `components/ui/list-detail.tsx`. The accent does not mark selection, and nothing marks it on one edge only.

### List and detail
Agents, Accounts, Health and usage, Projects and links and Orgs share one frame (`components/ui/list-detail.tsx`): a glass list on the left (264px, 296px from 1320px) and the picked item on the right, both as tall as the page and each scrolling inside itself with edge fades. The list groups rows by org under a small head (org badge, name, count, and a ghost + button when the group takes new items); a row is two lines, the name first and a status line under it, with its lamp or dot and word. A pinned footer holds the list's one action (New org, Add account, Register a repo). The detail has a fixed head (name, key facts, actions) over sections divided by hairlines, never boxed; each editable section keeps its own draft with Cancel and Save showing only while something changed.

### Status Lamp (signature)
A round lamp, 8px by default (7px in rails and docks, 6px in the connection indicator). Working: filled and breathing. Needs you and paused: filled with a steady glow ring. Done: filled, no glow. Idle: an unlit 1.5px ring. A dim lamp (35% opacity) keeps its colour but unlit, for a count of zero.

### Telemetry Strip (signature)
The top bar reads like a readout: the page headline, then counts ("28 open", "0 working", "1 needs you", "326M tokens today") with the number in telemetry mono and the word in Sans, separated by 16px hairline dividers. A count lights in its lamp colour only when above zero.

### Needs You Dock (signature)
In a task room, anything waiting for the owner stays in a glass dock above the message box (12px corners, 10px padding, needs-red tinted border, max 55% of the height, scrolls inside) until answered, headed by a 7px needs lamp and the words "Needs you". Answered items return to the log in place.

### Appearance picker
A popover of floating glass: a three-way theme segment (Dark, Light, System) and five round accent swatches, the chosen one checked. Saved in the browser; `index.html` applies the saved theme and accent before first paint so the page never flashes.

## Do's and Don'ts

### Do:
- **Do** keep the shell fixed at the viewport and scroll lists inside their panels with `scroll-fade` (or `scroll-fade-end` under a sticky header).
- **Do** pair every lamp colour with its word, label or count, and keep lamps `aria-hidden`.
- **Do** use resting glass for surfaces and floating glass (97.5% fill) for anything over content.
- **Do** set every number, id, handle and path in IBM Plex Mono with tabular figures, and everything else in IBM Plex Sans.
- **Do** collapse empty columns to 44px dashed rails with a vertical name and a mono count.
- **Do** tune new tokens for both themes and all five accents in `styles.css`; components use only the Tailwind tokens mapped to `--c-*`, whose default palette, sizes and radii are cleared.
- **Do** nest corners: 14px shell panels over 12px cards over 8px controls.
- **Do** mark the selected row with `ROW_SELECTED`: selected tint, inset ring all round, full text.

### Don't:
- **Don't** let the document scroll, or add a page-level scroll container.
- **Don't** use a lamp colour for an accent, a button, a chart series or decoration, and don't add an accent that lands on a lamp hue.
- **Don't** let colour alone carry a state.
- **Don't** raise the world's material cyan (hairlines, grid, rings) to lamp strength; full-strength cyan means working.
- **Don't** set prose, labels or titles in mono.
- **Don't** use the uppercase group label as a kicker or eyebrow above a title; it heads groups and table columns only.
- **Don't** draw an empty column as an empty box with "Nothing here".
- **Don't** use hard offset shadows, flat gray cards, or blur-dependent popovers.
- **Don't** recolour the `mj` mark with the accent; it stays amber.
- **Don't** mark selection or state with an edge bar: no coloured `border-left` or `border-right`, no one-edge `::before` stripe, no absolutely placed bar on a row's side. Use the selected tint and ring, a lamp with its word, or a frame tinted on every side.

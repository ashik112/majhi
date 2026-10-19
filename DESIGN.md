---
name: majhi
description: One calm console for agent work. Needs you, Work and Chat on one screen; flat panels, one primary button, red only for incidents.
colors:
  base: "#161617"
  panel: "#1c1c1e"
  card: "#222224"
  field: "#141415"
  raised: "rgb(255 255 255 / 0.04)"
  selected: "rgb(255 255 255 / 0.075)"
  line: "rgb(255 255 255 / 0.06)"
  line-strong: "rgb(255 255 255 / 0.08)"
  line-control: "rgb(255 255 255 / 0.13)"
  line-hover: "rgb(255 255 255 / 0.22)"
  fg: "#d6d6d9"
  fg-soft: "#b8b8bd"
  fg-muted: "#96969c"
  fg-faint: "#88888e"
  fg-dim: "#6e6e74"
  accent: "#e2ad5b"
  accent-hover: "#ebbb70"
  accent-ink: "#1d1405"
  accent-text: "#e6b86e"
  lamp-needs: "#e07a6f"
  lamp-working: "#78a8cc"
  lamp-done: "#78b394"
  lamp-paused: "#88888e"
  lamp-idle: "#6e6e74"
  blue: "#90b2d8"
  violet: "#b3a6d6"
  ws-0: "#8fb0d6"
  ws-1: "#b7a3dc"
  ws-2: "#7fc0b0"
  ws-3: "#d8b072"
  ws-4: "#e09a84"
  ws-5: "#a9b4c4"
typography:
  name:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: "20px"
  detail:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "19px"
  label:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "18px"
  group-label:
    fontFamily: "IBM Plex Sans, Helvetica Neue, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    letterSpacing: "0.08em"
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  2xl: "14px"
  full: "9999px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    height: "24px"
  button-outline:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    height: "24px"
  row:
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
  row-selected:
    backgroundColor: "{colors.selected}"
  pane:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.2xl}"
---

# Design System: majhi

## Overview

**Creative North Star: "One calm console"**

The owner lives in majhi all day and answers one question first: what needs me. So the app is one screen with three panes side by side: **Needs you**, **Work** and **Chat**. It lands on Needs you. Everything else (accounts, limits, usage, connections, skills, agents, memory, wiki, playbooks, audit, workspaces, projects) is Settings, one click from a gear in the top bar. The approved reference is `design/console.html`; the build follows it pair by pair.

The look is flat and quiet. Panels are plain surfaces with a hairline, no grid, no rings, no blur, no glow. Colour is rare so that it means something: red marks an incident and nothing else; a task that waits for the owner is a hollow ring in Work and a plain dot in the queue; running is a still dot. Nothing loops. A new item pulses once and is still. One filled button is on screen at a time: the selected row's main action.

The shell is the viewport (`100dvh`, no page scroll). Each pane scrolls inside itself. Words always sit beside colour; a lamp alone never carries meaning.

**Key characteristics:**
- Three panes (Needs you 34%, Work 36%, Chat 30%), 10px gaps (12px at Comfortable and Spacious), 14px pane corners.
- Four themes (Graphite default, Warm, Focus, Mission), each in Light and Dark; mode Light, Dark or System; density Compact, Comfortable (default), Spacious. All set from the sun button in the top bar, remembered in this browser, applied before first paint.
- One row anatomy in every pane, so the eye learns it once.
- Keyboard first: J K move, Tab changes pane, A does the main thing.

## Themes, modes and density

`data-theme` (`graphite`, `warm`, `focus`, `mission`), `data-mode` (`light`, `dark`, the resolved choice) and `data-density` sit on `<html>`; `index.html` sets them before the first paint from `localStorage["majhi.look"]` and `apps/web/src/lib/look.ts` saves them. All values are `--c-*` custom properties in `apps/web/src/styles.css`; the Tailwind tokens (`bg-card`, `text-fg-muted`, `border-line-strong`) map to them, so a screen follows the theme with no code. A theme is about 35 lines: the raw colours, with washes and soft tints derived once.

- **Graphite** (default): neutral grey, the calmest. Dark text is 11.7:1 on the panel.
- **Warm**: the same quiet with a brown tint; softer for long days.
- **Focus**: cool blue-grey; colour only for what is abnormal.
- **Mission**: the original look kept as a theme: blue-black glass over a radar grid, cyan hairlines, glowing lamps, the breathing working lamp. It is the only theme with blur, grid, halos and an animated lamp (`--glass-filter`, `--lamp-halo`, `--lamp-animation` are set only there).

Readable text is at least 4.5:1 on its panel in all twelve combinations (`fg`, `fg-soft`, `fg-muted`, `fg-faint`, and `accent-text`); `fg-dim` is for dividers and disabled things, never for words that must be read. Filled primary buttons use dark ink on the amber fill in every theme.

**Density.** Compact keeps the reason on the same line as the name (32px rows). Comfortable (default) puts the reason on its own line (13px, `fg-muted`) with 8px by 10px row padding. Spacious adds more room around rows, heads and panes. Only spacing and line breaks change; type sizes stay.

**Workspace identity.** Each workspace gets one of six hues (`--c-ws-0` to `--c-ws-5`), tuned per theme and mode so it never reads as a status. Workspaces take the hues in their list order; Private is always the neutral sixth. A workspace shows as a colour square and its name, never its key (`PRV`, `ACM`).

### Named Rules
**The Red Is For Incidents Rule.** Red (`lamp-needs`) marks an incident (a tinted frame, a red dot, a red count in the top bar) and a hollow ring in Work for "your call". Everything else that waits is a neutral dot. Never red for a button, a link or a chart.

**The One Primary Rule.** One filled (accent) button is visible on screen: the selected row's main action, in the focused pane. Other actions are outlined; hover offers a quiet outlined button on a row.

**The No Loop Rule.** Nothing animates forever in the flat themes. A new item pulses once (1.2s). Spinners and loading shimmers are the only loops, and only while something loads. Reduced motion turns every animation off.

**The Word Beside The Lamp Rule.** Every lamp has its word or count beside it ("your call", "working", "blocked"); lamps are `aria-hidden`.

## Colors

Plain neutral surfaces, five lamp colours for state, one accent for the main action.

- **Ground and panels** (`base`, `panel`, `card`, `field`): the page, a pane, a floating surface, an input well.
- **Raised and selected** (`raised`, `selected`): hover and the selected row; translucent white (dark) or black (light) so they work on any panel.
- **Line ladder** (`line` < `line-strong` < `line-control` < `line-hover`): dividers, pane borders, control borders, hover borders.
- **Text ladder** (`fg` < `fg-soft` < `fg-muted` < `fg-faint` < `fg-dim`): names, body, reasons, labels and counts, disabled.
- **Accent** (`accent`, `accent-hover`, `accent-ink`, `accent-text`): the main button, the focus outline, the caret, the text selection. Amber in every theme. The `mj` mark is amber always.
- **Lamps** (`lamp-working`, `lamp-needs`, `lamp-paused`, `lamp-done`, `lamp-idle`): the five states and nothing else. In the flat themes: working is a still dot, needs is a still dot (red only on incidents; hollow ring in Work), paused is a hollow ring, done a dot, idle a hollow ring.

Mission keeps its own palette (ground #050a13, glass at 60% with an 18px blur, cyan hairlines, brighter lamps); see its block in `styles.css`.

## Typography

IBM Plex Sans for words, IBM Plex Mono for numbers, ids, handles, paths and data (tabular figures).

- **Name** (500, 14px, 20px): the name of a row, `project · Name`, the project in its workspace colour.
- **Detail** (400, 13px, 19px): the reason or Now line, the open question, Next and Done when, chat text.
- **Label** (400, 12px): buttons, chips, status words, the top bar.
- **Group label** (500, 11px, 0.08em, uppercase, `fg-faint`): the head of a group (Incidents, Decide, Review). Workspace heads are 12px 600 in the workspace colour, not uppercase.
- **Data** (Plex Mono 11px): ages, counts, keys, facts.
- **Telemetry** (Plex Mono 500, 15px): the counts in the top bar.

Mission sets names at 13px, as the original console did.

### Named Rules
**The Mono Is Data Rule.** Mono only for numbers, ids, handles, paths, code and keys. Prose and names are Sans.

**The Tabular Count Rule.** Every count, time and percentage that can change is tabular.

## Layout

Top bar (one row, 14px corners): the `mj` mark (back to the console), the workspace filter (All, then each workspace as a colour square, its name and its waiting count; with more than six, five and "N more"), an Offline lamp when the server cannot be reached, the counts (incidents in red when above zero, need you, working, queued), search (Cmd K), the sun button, Settings.

Under it, the console grid. **Needs you** is a queue in four groups: Incidents, Decide, Review, Done by the captain. **Work** is grouped by workspace, then project, with Up next, Ideas and Done today as rails at the foot. **Chat** has chips for the captain, the selected task's room and client chats, a task header (name, workspace, Now, Next, Done when, facts) and the room.

- From 1240px up: three columns. Under 1240px: two columns and Chat slides in over the right when a task opens (`Tab` to it, or a click on a row); `Esc` closes it.
- Needs you with nothing in it folds to a 44px rail (dashed, a green dot, "Needs you · all clear" set vertically) and Work and Chat take the room.
- Offline: a banner on Needs you, the actions dim, answers wait. Keys say so instead of sending.
- Panes that are not in focus step back (82% opacity) and return on hover. The focused pane has a stronger border and its selected row open.
- Spacing runs on a 4px base. Row padding 8px by 10px (Comfortable); group heads add 16px above.

### Named Rules
**The Fixed Console Rule.** The document never scrolls. Every list scrolls inside its own pane. Lists over 100 rows are virtualised.

**The Rail Rule.** An empty thing is never an empty box. It is a slim dashed rail with its name and count.

## Row anatomy

Every row, in every pane: **lamp, `project · Name`, the reason or Now line, then a count, an age or a status word**. Comfortable puts the reason on a second line; Compact keeps one.

- The project is in the workspace's colour; with no project the workspace's name stands in.
- The selected row opens in place: the full question or Next and Done when, then its actions. Unset fields are hidden, never "Not set".
- The selected row's main action is the one filled button; the others are outlined; a ghost "Later" or "Open" ends the line.
- A row that merges repeats shows `×N` (5 tasks blocked by one closed task, 4 sign-ins). The groups come from typed fields, not from words (`packages/shared/src/queue.ts`).
- Work rows under a project head show the name only; the label `project · Name` is the row's accessible name and the Chat header.
- A group shows 8 rows, then "Show N more". "Done by the captain" shows 3.

## Keys

`J` `K` or the arrows move; `Tab` and `Shift+Tab` change pane; `A` does the selected row's main button; `Shift+A` does it for the whole group; `1` to `3` pick that answer; `E` puts a row off for four hours; `U` undoes; `Enter` opens (a task opens its page); `S` stops the selected task; `.` starts it now; `[` folds its workspace; `C` writes in the chat; `Esc` closes the chat or leaves a message box. `N` is a new task, `Cmd K` the palette, `?` the list. Keys do nothing while the owner types in a field or a dialog is open. Every action leaves an Undo toast for five seconds: a question is held by the server for that time, other answers are held in the page and sent when the time is up (a reload before then puts the row back).

## Elevation and depth

Flat themes: no shadows at rest. Floating surfaces (menus, the appearance popover, the undo toast, dialogs) use `card` fill, a hairline and one soft shadow (`0 18px 40px -12px` at 60%, lighter in light mode). Mission: glass over the radar backdrop with the original shadows.

## Components

**Buttons.** 24px tall in the console (28, 34, 40, 44 elsewhere), 8px corners. Primary: accent fill, ink text, semibold. Outline: raised tint, `line-control` border. Ghost: no border, muted. Focus is a 2px accent outline. Disabled is 45% opacity. A key hint (`A`) sits on the primary only.

**Chips and segments.** A 3px-inset track with 26px segments; the pressed one has the selected tint and a 1px ring. The workspace filter, the mode and density pickers and the chat chips use it.

**Appearance popover.** Four swatches (each shows the theme's light and dark panel), then Mode and Density segments. Esc closes it.

**Toast.** Bottom centre, floating surface: what was done and `Undo U`. Five seconds.

**Settings.** The existing list-and-detail pages inside one frame with a Settings list on the left. They follow the themes through the same tokens.

## Do's and Don'ts

### Do:
- **Do** keep the shell at the viewport and scroll inside panes.
- **Do** read colour from tokens in `styles.css`; add a token for both modes of every theme.
- **Do** put a word beside every lamp.
- **Do** keep one filled button on screen and make it fit the row's state (Answer, Unblock, Start now, Stop).
- **Do** judge a screen with the longest names, 100+ rows and an empty state, at 1440 and 1100 wide, light and dark.
- **Do** keep Mission as a theme: its glass, grid and glow live only under `data-theme="mission"` or in tokens only it sets.

### Don't:
- **Don't** use red for anything but an incident and the hollow "your call" ring.
- **Don't** add an animation that loops, a glow, a grid or a blur outside Mission.
- **Don't** show a workspace by its key.
- **Don't** put a native `title` tooltip on a row that re-renders; the label is the row's accessible name.
- **Don't** set prose in mono, or show "Not set" for an empty field; hide it.
- **Don't** mark selection on one edge only (no coloured side bar); use the selected tint and ring all round.
- **Don't** draw an empty column as an empty box with "Nothing here"; it is a rail.

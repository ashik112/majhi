# Brief: UI reset (places, settings, task page, chat, setup)

The owner approved the mockups on 2026-10-21. The build starts only after the owner approves this brief. It uses one branch (`feat/ui-reset`), one worktree and one builder, and the parts are built in the order below.

## Why

- A new user did not know what to do: add accounts, then agents, and where are the projects?
- The task page header took a third of the screen, and the chat got a narrow column in the middle.
- Chat messages were long and repeated themselves. Steps hid what the agent was running.
- Watch and Wiki, which the owner checks daily, sat inside Settings with 27 other entries.

## Read first

`CLAUDE.md`, `DESIGN.md`, SPEC 3.1, 3.6, 5.3 and 5.15, and the mockups (their path is in the agent prompt). The code map:

- Top bar: `features/console/top-bar.tsx`, `console.css`. Routes: `router.tsx`, `PAGE_PATH` in `packages/shared/src/screens.ts`.
- Settings list: `SETTINGS_GROUPS` in `screens.ts`, rendered by `features/settings/settings-frame.tsx`. Sections: `features/setup/setup-view.tsx`.
- Task page: `task-screen.tsx`, `task-header.tsx`, `task-facts.tsx`, `room-panel.tsx`, `room-rail.tsx`, `processes-card.tsx`, `room/incident-card.tsx`, `room/timeline.tsx`.
- Chat: `room/items.tsx` (`MEASURE`, `AgentMessage`), `room/tool-row.tsx`, `room/steps-row.tsx`, `room/ask-card.tsx`. Room items: `packages/shared/src/tasks.ts`. Processes: `packages/shared/src/processes.ts`, `apps/server/src/processes/notices.ts`.
- Setup: `apps/web/src/onboarding/*`, `features/home/app-gate.tsx`.
- Writing rules: `apps/server/src/tasks/brief.ts`, `admin/boss.ts` (`ADMIN_PREAMBLE`, `SCREEN_MAP`), `autonomy/preamble.ts`, `onboarding/model.ts` (`BOSS_INSTRUCTIONS`).

## 1. Top bar and places

- **Places:** add Home, Watch, Wiki and Usage after the boat mark, as links with an active state. The gear stays at the right and opens Settings.
- **Counters:** keep incident and need you. Remove working and queued; the Work pane shows them.
- **Theme:** the Appearance button leaves the top bar; the bell (part 7) takes its place. Its choices move to Settings › Look and alerts.
- **Narrow screens:** below 1300 px, the workspace chips become one "All workspaces ▾" select over the same filter state.
- **Settings frame:** Watch (`/watch`), Wiki (`/wiki`) and Usage (`/usage`) keep their paths and no longer sit in it.
- **Wiki tabs:** Pages and Memory. Memory is today's `/memory` page, and `/memory` redirects to `/wiki?tab=memory`.
- **Usage tabs:** "Health and cost" and "Activity". Activity is today's audit log, and `/audit` redirects to it.

## 2. Settings: 14 entries in 4 groups

| Group | Entry | Holds today's |
|---|---|---|
| Workspaces | Workspaces | Workspaces |
| | Projects | Projects and links, Project folders |
| Sign-ins | AI accounts | Accounts |
| | Git and SSH | SSH keys, git logins |
| | Connections | Connections |
| Agents | Agents | Agents, Captain |
| | Approvals | Approvals |
| | Skills and tools | Skills & MCP |
| | Playbooks | Playbooks |
| | Limits | Turns, Context and limits, Limits |
| App | Look and alerts | Appearance, Notifications |
| | Editor | Editor |
| | Local model | Laya |
| | System | Containers, Backups, History |

- **Merged entries:** an entry that holds several of today's pages shows their existing panels one after another, each under its own heading. No new panels.
- **Removed:** Overview (Home covers it). Watch, Wiki, Memory, Health & usage and Audit log become places.
- **Memory rules:** open from a "Rules" button in the Wiki › Memory header, as a dialog with today's panel.
- **Wiki settings:** open from a "Settings" button in the Wiki › Pages header, the same way.
- **Old links:** every old link (`/setup?section=x` and the old page paths) redirects to the new home of x.
- **Captain:** `SCREEN_MAP` points at the new places.

## 3. Task page

**Header**, one row:
- Left: back, workspace badge, title (still editable) and status.
- Middle: the tabs Room, Brief, Changes (only with a repo), Report and Terminal.
- Right: the incident chip, one action (Start, Resume or Stop) and ⋯.

**What leaves the header:**
- The breadcrumb text and the cost.
- The "From" chip and the Watch chip, which move to the Task card.
- The description with Show all and Edit, which moves to Brief.
- The Brief button and the subtasks trail, whose content is already in the Subtasks card.

**Brief tab:**
- It holds today's Context and Memory tabs, plus the description and the task links.
- The Goal line from today's summary card opens it.

**The summary card above the chat is removed:**
- Cause, Client told and Follow-ups move to the Incident card.
- Branch is already in the Branch card.

**Side panel:**
- On top: a new **Incident card** (lamp, open time, a 4-stage bar from `CLIENT_STATUS_LABEL`, Cause, Client, Follow-up links) and a **Task card** (From, Cost).
- Below them, today's cards keep their content: In this room, Subtasks, MR, Branch and Changes.
- An empty card renders nothing.
- At 1300 px or wider the panel is inline. Below that it is hidden, and ⋯ › Details opens today's overlay. The `w-11` rail is removed.

**Above the composer:**
- The incident status becomes one line: lamp, Incident or Recovered, stage text, Details ▾ (opens today's card body) and its actions.
- The Paused card and other "Needs you" items stay.

## 4. Chat

**Width and message header**
- **Width:** remove `MEASURE` (72ch) and the 920 px cap on the list. Messages use the room's full width with the existing gutter.
- **Message header:** name and time only. Account and model move to the name's hover title.
- **"Step N of M done by @agent: …" line:** no longer created (`tasks/crew-run.ts`), and existing ones are hidden. The agent's message already says it.

**Finished turns**
- The steps between two messages (tools, thinking, rule approvals, notes like "majhi restarted") fold into one line under the message, for example: "▸ 3 steps · ran `date -u …` +1 · majhi-tasks: get, status · 1 allowed by rule".
- A click opens compact rows: icon, title, then the status mark right after the text.

**A turn that is running**
- Its steps stay open under the message: "@agent is working · 2:14 · 9 steps, 5 earlier ▸", followed by the last 4 rows.
- The row in progress shows a live timer (from the item's `at`) and Stop, which stops the run.

**Processes**
- A background process becomes a room item where it started: kind `process`, upserted by id `process:<id>:<startedAt>`, with the fields of `ProcessInfo`.
- It renders as one line: lamp, "Process", the command, where it runs, run time or exit, Output ▸ (the tail), Open (when it has a port) and Stop.
- It updates in place when the process ends. This replaces today's separate `process-end` notice, whose old items still render.
- The Processes card leaves the panel.

**Ask card and inline code**
- **Ask card:** the question rendered as markdown, its choices, and Reply. Nothing else.
- **Inline code:** short code (40 characters or fewer) never breaks across lines. Longer code wraps only at spaces and slashes.

**The Needs-you block above the composer** (approved 2026-10-22):
- One card per task, never a stack. When an incident recovered and its agent is paused, the owner sees one card: lamp, a bold first line ("Recovered. Close it?"), one plain line on why the agent stopped, and the actions.
- One Close action. "Close incident" and "Close: it recovered" become one Close. "Let the lead continue" is shown only when the lead is not running.
- Follow-ups and any other long text fold behind "Follow-ups (N) ▸" and render as markdown, inline code included. Raw `**` or `- ` never shows.
- A message that is not a question is never labelled "asks".
- No Paused card for a pause majhi heals by itself (the case-flow watchdog). After its retries fail, one line with the one fix, for example "Sign in again" with its button.
- Pause reasons are written for the owner: what stopped and what to do, never internals like "did not read the profile".
- Body text uses the normal text colour, not the muted one.

## 5. One writing rule for the room

**Where it lives:** one shared text, "Writing in the room", imported by TASK.md (`brief.ts`), the captain (`ADMIN_PREAMBLE`), the autonomy preamble and `BOSS_INSTRUCTIONS`, replacing the scattered one-line rules.

**What it says:**
- First line, in bold: the outcome.
- Then "Needs you" with one line per action, only when the owner must act.
- No story of what you checked, and no repeating the task.
- Cause, evidence, timeline and follow-ups go in REPORT.md, and the message links it.
- Six lines at most.

## 6. Setup in 3 steps

1. **Sign in.** One button each for Claude and Codex.
   - The account id comes from the tool and the signed-in email.
   - A workspace named "Personal" is made without asking; it can be renamed later.
2. **Projects.** majhi scans the usual folders (`suggestRoots`, `listDirs`) and lists the git repos it found with checkboxes. "Add another folder" is there too.
3. **First task.** One text box and Start.

**Made automatically with defaults:** the workspace, the account id, one lead agent and the captain (`BOSS_INSTRUCTIONS`).

**Not in setup any more:**
- Git sign-in is asked the first time a task wants to push, as a card in that room.
- The other steps of today's wizard stay in Settings.

**Home:** while there is no project, the Work pane shows "Add a project". It opens step 2 as a dialog.

## 7. Home: cards, bell, unread, chat width

Approved 2026-10-22 from the mockups `cards-1440.png`, `cards-1100.png` and `cards-1100-needs-open.png` (path in the agent prompt).

**Work cards: each state looks different.** No left stripe on any card.
- **Incident:** red border with a soft glow, an INCIDENT tag, the client and the time; then "Client told …" and "Now …".
- **Working:** amber border with a soft glow, a WORKING tag, the agent and the run time; then "▶ Running `command` 0:08" on one line (the command is cut with …, the live timer stays visible), "Next …" and Stop.
- **Needs you:** blue border, a NEEDS YOU tag, the question and its buttons on the card.
- **Blocked:** muted, a BLOCKED tag, "Waits for …". No actions.
- **Done today:** a tick line, no card.
- The state comes from data the Work pane already has (`stateOf`, the latest status `now`, the running tool row). No new store.

**Bell:** in the top bar, where the Appearance button was. A red count of urgent items: an unanswered client message, a paused captain, an open incident. A click opens the list; each row opens where the thing lives.

**Unread counts:** every unread count (chat tabs, New chats) is a solid red badge with white text. "+N more" carries the sum of the unread counts of the chats it hides.

**Chat width:** at 1300 px or wider the Home columns are about 0.85 : 1 : 1.6 (Needs you : Work : chat).

**Narrow screens (below 1300 px):**
- The chat is always shown next to Work (about 1 : 1.35). It is no longer a hidden slide-over.
- Needs you becomes a 52 px rail at the left: a red count, "Needs you" written vertically, a red dot with "N incidents" when there are any.
- A click on the rail, the "need you" counter or the bell slides the full Needs-you list over Work. The chat stays visible. Esc or the rail closes it.

## Tests (only these; each a row in `docs/briefs/test-guarantees.md`)

- Setup's automatic ids never replace an existing account, workspace or agent. A clash gets a new id.
- A process room item stays one item per process run, and its end sets the exit and the end time, including after a server restart.

## Done means

- **Walk** in a throwaway majhi (`e2e/start-server.ts`, never port 7070), with the fake ACP agent running commands and one background process, at 1100 px and 1440 px, dark and light:
  - a new user from an empty majhi to a first task;
  - every place and every Settings entry;
  - a task with an incident;
  - a task with an agent at work;
  - an ask card;
  - Home with every card state, the bell, red unread counts, and the narrow rail opened and closed.
- **Mockup parity:** each built screen next to its approved mockup, pair by pair. Report what differs.
- **Old links** still open what they opened.
- **JS budget:** at most 150 KB for the first load.
- **Docs:** DESIGN.md (top bar, places, settings, task page), SPEC 3.1, 3.6, 5.3 and 5.15, and DECISIONS rows.

Rules: `CLAUDE.md`. Generic sample names only. No regex for decisions. Commits never mention an AI assistant. Never push or merge. One heavy job at a time.

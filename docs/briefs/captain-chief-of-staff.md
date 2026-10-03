# Proposal: the captain as chief of staff

Status: approved by the owner on 2026-10-04. It changes SPEC 5.16 and 5.18 and replaces how autonomous mode (PRV-74) is shown and switched. Built so far: steps 1, 2 and 7.

## Why

On 2026-10-03 the owner hit these in one evening:

- Two on/off systems. Autonomous mode had On, Pause, Stop gracefully and Stop now. "Stop the captain" also turned autonomous mode off.
- "Runs it" behaved like "Keeps things tidy" whenever autonomous mode was off, so the level shown was not the level in force.
- Three kinds of money limit (autonomous day cap and workspace caps, weekly budgets, account floors). Every pause card said "weekly budget", and a Stop now pause said "You stopped it."
- To change a cap, the owner stopped autonomous mode, which paused three tasks that stayed paused.
- The captain's chats are ordinary chat tasks (PYZ-2, LOCAL-16). They show in the Chats list next to the owner's own chats, and the owner can delete them.
- The captain waited behind workers for a slot, so a question to it took five minutes to answer.
- The captain refused to act in a task the owner had opened in the last 10 minutes.

A CEO does not run a company with modes. They hire one person they trust, give that person a budget and authority, see only the decisions that need them, and keep one switch for when they want the delegation to stop.

## The model

### 1. One switch: Autonomous, On or Off

Autonomous mode spends money, so it has one global switch in the sidebar and on the Captain page.

- **On:** the captain acts by itself in each workspace, within that workspace's authority (2) and budget (3).
- **Off:** the captain acts only when the owner talks to it. It starts nothing, ships nothing and answers no cards by itself.
- **Turning off** pauses the tasks it started right away (default). The owner can pick "Let them finish their current step" instead. Either way nothing it started is lost.
- **Turning on** lists the tasks it paused and resumes them, with a checkbox to leave them paused.

This replaces Pause, Stop gracefully, Stop now and "Stop the captain". The captain itself is never "stopped": the owner can always talk to it.

### 2. Authority per workspace

One table per workspace, read as a delegation policy. Each row is "Captain decides" or "Ask me".

| Acme | Captain decides | Ask me |
|---|---|---|
| Pick and start work from the backlog | | ✓ |
| Answer agents' questions | ✓ | |
| Answer routine approval cards | ✓ | |
| Upkeep (memory, projects, triage, cleanup) | ✓ | |
| Merge into the base branch | | ✓ |
| Push and open merge requests | | ✓ |

- New client workspaces start with every row on "Ask me" except upkeep. Private starts as today's "Keeps things tidy".
- The table applies only while Autonomous is On. While Off, every row behaves as "Ask me".
- The never list (SPEC 5.18) still applies and is not shown as rows.

This replaces "Only when I ask", "Keeps things tidy" and "Runs it", and the separate push and merge switches.

### 3. Budgets

- **Autonomous budget per day,** one number for all of autonomous work: the captain's own turns plus every task it starts or resumes. Required while Autonomous is On, because the owner's tokens are not unlimited.
- **Workspace budget per day,** optional, inside the autonomous budget. Empty means the workspace shares the whole autonomous budget.
- **Account floors** (keep a share of each 5-hour window and week) and **weekly budgets** (which also limit the owner's own tasks) stay, on the same Limits screen under "Safety".
- When a budget runs out, the captain asks, as a decision (4): "Pyzasoft used its $20 for today. 3 tasks are waiting. Raise it to $40 for today?" with Raise and Leave buttons. A task held by a budget says which budget, by name.
- Spend is shown per workspace and in total, against these numbers, in one place.

### 4. One inbox: Decisions

Everything that waits for the owner is a decision with the captain's recommendation and one-click answers: agents' questions the captain may not answer, approvals above its authority, ready-to-ship work, budget raises, branch rewrites.

> **PYZ-3: clean the branch history?** Captain recommends **Rebuild** (keeps a backup branch, nothing pushed).
> [Approve] [Other options] [Open task]

The bell opens this inbox. Desktop and browser alerts are sent only for decisions, never for things the captain handled.

### 5. Overrule, do not babysit

- The 10-minute presence rule goes. Within its authority the captain acts in any task; while the owner is typing in a task, it waits until the owner sends or leaves.
- Every captain action is labelled "Captain", never "You", in rooms, cards and the log, with its reason and Undo where Undo exists.

### 6. The captain never waits in line

The captain has its own run slot, outside "agents at once" and "per account". Its turns are short (read, decide, answer), so an owner's message gets an answer in seconds. Its spend still counts against the autonomous budget and the account floors.

### 7. Workspaces never collide

- **Context:** one session per workspace ("lane"), as today. A lane reads and acts in its own workspace only (SPEC 5.18 lane scope).
- **Slots:** while Autonomous is On, the agent slots are split evenly across the workspaces that have runnable work, so one busy client cannot take every slot. A workspace with nothing to run leaves its share to the others, and the owner's own tasks always come first.
- **Accounts:** two workspaces that share an account (for example Private and Pyzasoft on `claude-personal`) share its per-account slots and floors fairly, in turn.
- **Repos:** the captain never runs two tasks that write to the same repo and base branch at once unless their plans touch different areas; otherwise it queues the second and says why. Ships into the same base branch go one at a time, in order.
- **Budgets** are per workspace (3), so one client cannot spend another's money.

### 7b. Staffing and lead handover

- **Staffing weighs everything, with no built-in preference.** For each task the captain considers the task's size and kind, every agent that may work in the workspace (role, skills, model and effort), each account's free slots and usage left in its 5-hour window and week, the floors and budgets, the expected cost, how agents did on similar work in this repo, and the repo rule (7). It picks the team that does the work best within those limits, from one agent to a lead with builders and a reviewer, and says why in one line ("@acme-lead on claude-acme-2: free slot, 60% of its window left; @acme-builder joins for the tests"). Another workspace's agents and accounts are never considered.
- **Lead handover.** The lead, the captain or the owner can make another team member the lead (`tasks.setLead`), for example when the lead's account is at its limit, the task needs another skill or model, or the lead is stuck. The new lead must be on the team or able to join it; the old lead stays as a builder or leaves. The handover posts a note in the room with the plan, what is done and what is next, so the new lead starts with the context.

### 8. The captain's chats

- The captain gets **one place,** the Captain panel (Cmd J and the Captain page). It has one thread per workspace and an "All" view. These threads are where autonomous work is reported and where the owner talks to the captain about that workspace.
- Workspace threads are **not tasks** in the owner's lists: they never show in Chats or on the Board and cannot be deleted. "Start fresh" clears a thread's session and keeps a short summary, so a long thread does not grow without end.
- A **topic chat** the owner starts with the captain ("help me set up MCP skills") is an ordinary chat, shown in Chats and deletable, like a chat with any other agent.
- Existing lane chats (PYZ-2, LOCAL-16) move into their workspace threads. Old captain topic chats (LOCAL-12, LOCAL-14) stay in Chats.

### 9. Briefings

One summary per day, at 08:00 by default and changeable on the Captain page: what shipped, spend per workspace against its budget, what waits on the owner, and what the captain plans next. It sits at the top of the Captain panel and links to the Decisions inbox.

## Moving today's settings

| Today | Becomes |
|---|---|
| Autonomous mode on, paused, stopping | Autonomous On |
| Autonomous mode off | Autonomous Off |
| "Stop the captain" set | Autonomous Off |
| Only when I ask | Every row "Ask me" |
| Keeps things tidy | Upkeep, questions and routine approvals "Captain decides"; the rest "Ask me" |
| Runs it | Every row "Captain decides" except push and merge, which follow today's push and merge switches |
| Day cap | Autonomous budget per day |
| Workspace cap | Workspace budget per day |
| Lane chat tasks | Workspace threads in the Captain panel |

## Build order

Each step ships on its own and is usable without the next.

1. **Captain's own slot and "Captain" labels.** Smallest change, fixes the five-minute wait and "You stopped it".
2. **One switch** (1) and the move of today's mode and stop states, with resume on turn-on.
3. **Authority table** (2) replacing the three levels and the push and merge switches. Built: rows stored as `authority` per workspace, old fields still read; Hub setup and the Limits screen no longer carry push and merge.
4. **Budgets and Limits screen** (3), with budget decisions.
5. **Decisions inbox** (4) and alerts for decisions only.
6. **Collision rules** (7): fair slots per workspace and account, the repo rule.
6b. **Staffing and lead handover** (7b).
7. **Captain panel threads** (8), moving lane chats out of the task lists.
8. **Presence rule replaced** (5) and **briefing** (9).

Each step comes with tests for its state logic (switch, resume, budgets, fair slots, the repo rule) and a browser check of the screens it changes, at 1440 and 1100 wide.

## Answers

Owner, 2026-10-04: slots split evenly across workspaces; turning off pauses its tasks now by default; the daily summary stays at 08:00 and is configurable.

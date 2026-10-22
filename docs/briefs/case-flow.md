# Brief: one client problem, one case, handled while the owner sleeps

Approved by the owner on 2026-10-22, after the Acme outage that morning. This rebuilds one flow: a client reports a problem in a chat, and majhi fixes it and tells the client. It does not touch any other flow.

## What went wrong on 2026-10-22 (the replay this brief must pass)

- **13:37** Ana (client, Telegram group "Orders for Acme"): "print slips are not generated and orders cannot be sent to the courier". **13:39** a second message about the same problem.
- The captain lane was paused, and its folder was deleted (fixed on main: `cee1d50b`). The message was marked "had nothing to send". The owner was asleep.
- Once running, the captain and a lead:
  - asked the owner to approve every read-only `ssh` (`docker ps`, `docker logs | grep`);
  - created tasks in the wrong workspace, then filed majhi bugs about it;
  - split the work into plan steps with hand-offs and send-backs;
  - wrote a code patch and test builds nobody asked for;
  - lost an approved `docker restart` (being fixed on its own branch).
- The real cause was simple. Copies of a courier status sweep filled all 3 slots of Acme's celery worker. A `docker restart` of that worker cleared it in seconds.
- The client was told 2 hours later, after the owner pushed by hand. Work was spread over GLX-19, GLX-22, GLX-34, GLX-35, a captain lane and a client room.

## The flow to build

1. **A client message opens or joins one case.**
   - A case is the existing incident task kind (extend the model, do not add a parallel one). It belongs to the chat's workspace, and only that workspace.
   - Another message about the same problem joins the open case; it does not get its own reply or task.
   - Open cases from older days are not reused for a new problem. The 2026-10-08 incident was joined by today's report, and its bar showed Oct 8 facts.
2. **The captain works the case itself, in the case.**
   - No lead, no team plan, no plan steps, no hand-offs, no send-backs, and no new tasks.
   - Its words go in the case room, and the client gets replies in the chat.
3. **Without asking the owner** (workspace authority Routine or Full):
   - Every read on the workspace's connected hosts and services: logs, `docker ps`, `docker inspect`, files, read-only database queries and status endpoints. Decide by parsing the command into a typed form, with an allow list of read verbs per tool. Never use regex on text. When a command cannot be parsed as a read, it counts as a write.
   - Reversible recovery on a connected host: restarting or recreating a service or container on the same image and config, and clearing a stuck queue by restarting its worker. Each is done once per case; a second attempt asks.
   - Messages to the client about the case: an acknowledgement, a finding in plain words, "fixed, please try again".
4. **Asks the owner once, as one Needs-you card with buttons, only for what cannot be undone:**
   - deploying new code;
   - changing env or config files on a host;
   - database writes, or deleting data or volumes;
   - spending money;
   - anything the workspace authority is set to "Ask me" for.

   While a card waits, the captain keeps working on whatever does not need it.
5. **The case ends itself** when the client's symptom is checked as gone (the thing the client said fails works again, verified by a read). The captain tells the client and closes the case with a 3 to 6 line summary. That summary is the one thing the owner reads in the morning, as a line on Home under Done today.
6. **Follow-ups** (a code fix to prevent it again, a monitor to add) are a short list on the case. None becomes a task unless the owner presses "Make it a task" on it. The captain never files tasks or majhi bugs from a case.
7. **Bounded:**
   - At most 20 tool calls and 30 minutes of captain time per case before it stops and writes one Needs-you card: what it knows, what it tried, the one thing it needs.
   - The same command never runs twice in a case unless its result changed.
   - No case without a client symptom.

## Remove from this path

For client-chat cases: team plans, step hand-offs, send-backs, captain-created tasks, `reportBug` and per-command approvals of reads. Keep the code where other flows use it; cut only this path's calls to it. The things removed are named in DECISIONS.

## UI (no new screens)

- **Home:** an open case is one line in the existing Work pane, with a lamp, the title, the client and the time. Under it:
  - **Now:** one live line from the captain's latest status (the existing `status` tool's `now`);
  - **Needs you:** shown only when a card waits.

  A closed case moves to Done today with its summary.
- **The case's incident bar** shows this case's facts only (fixes the stale Oct 8 bar).

## The test: the Acme replay

Build it with the fake ACP agent (`packages/acp/testing`), a scripted captain, and a fake ssh host whose worker is "stuck" until it is restarted.

- **Input:** Ana's two messages, 2 minutes apart, while the owner never clicks.
- **Expected:**
  - one case in Globex;
  - reads ran with no approval card;
  - the restart ran once, with no card;
  - a read shows that slips work;
  - the client got 2 messages at most (acknowledgement or finding, then "fixed, please try again");
  - the case closed with a summary line in Done today;
  - zero tasks created and zero majhi bugs filed;
  - the owner's Needs you is empty.
- **Second run:** the same replay where the fix needs a code deploy. It must end with exactly one card, "Deploy fix X to Acme?", with the client told it is being worked on.

Tests: only these two replays and the read/write command classifier (security), each a row in `docs/briefs/test-guarantees.md`.

## Done means

- Both replays pass.
- Walk the Acme replay in a throwaway majhi (`e2e/start-server.ts`, never port 7070) and screenshot Home at each stage.
- The DECISIONS row names what this changes in the authority model: Routine now allows reads and reversible recovery on connected hosts.
- The owner sees it before merge.

Rules: CLAUDE.md. No regex for decisions. Generic sample names in code, tests and docs (Acme, Globex; never the real client names in this brief). No AI in commits. Never push or merge, and never touch the live majhi or `~/.majhi`. One heavy job at a time.

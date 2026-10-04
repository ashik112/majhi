# Glossary

One word for one thing in the app's text. `apps/web/src/lib/naming.test.ts` fails when a retired word comes back.

| Thing | Say | Do not say |
|---|---|---|
| Something that waits for the owner | Decision (place: Decisions; lamp word: Needs you) | inbox item, card, notification |
| Count of those | The length of `decisions.list` (`useNeedsYou`) | a count of tasks or cards |
| Decision kinds | Ship, Question, Access, Money, Paused, Trust | Review, Ready for review, Approvals, Budget or Daily limit as a kind |
| Work that stopped on the Board | Waiting (the column) | Needs you (the column) |
| Failed health checks | N to fix | N need you |
| What the captain may do in a workspace | The plain sentence from `authorityLine`: "In Acme you decide when work is merged." | Keeps things tidy, Runs it, Only when I ask |
| Money limits | Budget | cap, daily limit |
| The row that lets the captain approve routine requests of work it started | Own work | self-approve, auto-approve |
| Approving or rejecting many decisions at once | Batch: "Approve N", "Leave N", "Approve all like this" | bulk, mass approve |
| What the captain did and how it turned out | Scorecard ("Kept 47/50, $3.10, ~2.5 h saved") | report card, KPIs, accuracy score |
| A row dropping back to You by itself, or a channel to Draft | "went back to You" (Trust decision) | demoted, downgraded |
| A proposal to let the captain decide more | "Let it decide", "Move to Batch" (Trust decision) | upgrade, promote automatically |
| A playbook set to weekly because its findings were dismissed | "now runs weekly" (Undo) | muted, disabled |
| The one monthly spend limit | Monthly ceiling | monthly budget, hard cap |
| Spend against what a client pays | Profit and loss; "Retainer less spend" | margin, ROI |
| The day's ordered list of what needs the owner | Agenda (place: Today) | to-do list |
| The text made each morning | Brief (the full sheet is still the Daily summary) | digest, briefing |
| The owner's review time per day | Review time | review budget, minutes cap |
| Majhi's check of finished work before "Ready to ship" | Hand-off check; "Checked: tests 42 passed (31 s), build ok" | QA, validation, CI, gate |
| A test that failed and then passed on a retry | flaky, so not green | unstable, intermittent |
| A failed check sent back to the lead | "sent it to @lead" (once per commit) | rejected, bounced |
| Three failed hand-offs in a row | "Checks failed 3 times in a row: you decide" | escalated |

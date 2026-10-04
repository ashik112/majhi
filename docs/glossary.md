# Glossary

One word for one thing in the app's text. `apps/web/src/lib/naming.test.ts` fails when a retired word comes back.

| Thing | Say | Do not say |
|---|---|---|
| Something that waits for the owner | Decision (place: Decisions; lamp word: Needs you) | inbox item, card, notification |
| Count of those | The length of `decisions.list` (`useNeedsYou`) | a count of tasks or cards |
| Decision kinds | Ship, Question, Access, Money, Paused, Incident | Review, Ready for review, Approvals, Budget or Daily limit as a kind |
| Work that stopped on the Board | Waiting (the column) | Needs you (the column) |
| Failed health checks | N to fix | N need you |
| What the captain may do in a workspace | The plain sentence from `authorityLine`: "In Acme you decide when work is merged." | Keeps things tidy, Runs it, Only when I ask |
| Money limits | Budget | cap, daily limit |
| The row that lets the captain approve routine requests of work it started | Own work | self-approve, auto-approve |
| Approving or rejecting many decisions at once | Batch: "Approve N", "Leave N", "Approve all like this" | bulk, mass approve |
| A confirmed outage of something watched, or a failing check of majhi itself | Incident (place: Watch) | alert, ticket, outage card |
| The page of watched services and incidents | Watch | Uptime, Monitoring, Ops |
| Telling majhi you saw an incident | Acknowledge | ack, dismiss, snooze |
| The push to your phone | Phone push, through ntfy | SMS, pager, notification (for the push) |

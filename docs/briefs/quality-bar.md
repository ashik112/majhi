# Quality bar for captain v2 and everything it touches

Owner, 2026-10-04. Every change in the captain v2 plan meets all of this before it merges.

## Daily operations first

- The owner lives in majhi every day. Every screen answers "what needs me, what is happening, what did it do" in seconds, with the fewest clicks and no tab hopping.
- Logical and cohesive: one name for one thing everywhere, one place for each setting, the same patterns on every screen (queue on the left, detail on the right; actions inline; keyboard first).
- Follow DESIGN.md. Industry-leading means calm, dense where it helps, fast, and obvious, not decorated.
- Judge every screen on realistic volume (hundreds of log lines, dozens of decisions, long names, empty states, errors), at 1440 and 1100 wide, dark and light.

## Tests that try to break it, not happy paths

- Every crucial path has tests for failure and abuse: bad input, missing data, timeouts, the provider down, races (two wakes at once, a resume during a pause), restarts mid-run, caps and budgets at the edge, duplicates, permission refusals, prompt-injection text in repo files and messages, other workspaces' data.
- A test asserts what the owner observes (state, room lines, decisions, money), not that a function was called.
- Each capability has at least one end-to-end test that drives a real captain turn through the fake agent's script mode, including a turn that goes wrong.

## Fast and light

- Pages render from cached queries and stream updates; no request waterfalls; long lists are virtualized.
- Server work is incremental: sensors read what changed since the last look, not everything again.
- Measure: note p50/p95 of any new command or page load in the report.

## Best value at the lowest cost

- Rules and cheap code first, then Laya (local, free) as the first pass, then the smallest model that does the job, then the big model, then the owner.
- A playbook run that finds nothing costs no model tokens (preflight in code).
- Batch model calls; cache repeated questions; keep prompts and context small; never send a whole log or repo where a slice will do.
- Every model call is attributed (workspace, playbook, use) so the scorecard can show cost per outcome.

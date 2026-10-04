import type { CaptainChore } from "@majhi/shared";
import type { CaptainPorts } from "./ports.ts";
import type { ChoreRun } from "./runner.ts";
import { type Candidate, MAX_ACCOUNT_SLOTS, type Signal } from "./upkeep-ports.ts";

/**
 * The self-upkeep chores: the captain keeps majhi itself in shape. Each run is cheap, one pass over
 * ports, no model turn. What it finds becomes a finding (filed once; a dismissed one never comes
 * back) and what it fixes goes in the log. Destructive steps always wait for the owner.
 */

/** Tools proposed in one run. */
const MAX_PROPOSALS = 3;
/** Search words used in one run. */
const MAX_TERMS = 4;
/** Findings one tidy or checklist run files. */
const MAX_SIGNALS = 10;

type Chores = Pick<
  Record<CaptainChore, (run: ChoreRun) => Promise<void>>,
  "discover" | "tidy" | "health" | "checklist"
>;

const clip = (s: string, n = 100) => (s.length <= n ? s : `${s.slice(0, n - 3)}...`);

/** What a rejected or proposed tool is remembered by. */
export function discoverKey(c: Pick<Candidate, "kind" | "id">): string {
  return `discover:${c.kind}:${c.id}`;
}

/** "fixed 2, 1 for you", or the words for nothing. */
function line(fixed: number, left: number, none: string): string {
  const parts = [...(fixed > 0 ? [`fixed ${fixed}`] : []), ...(left > 0 ? [`${left} for you`] : [])];
  return parts.length === 0 ? none : parts.join(", ");
}

export function createUpkeepChores(ports: CaptainPorts): Chores {
  const findings = ports.findings;
  const off = (run: ChoreRun, id: string) => run.ws.rulesOff?.has(id) === true;

  /** Files a finding once. Known in any state, even dismissed, it is left alone. True when filed. */
  const file = async (run: ChoreRun, s: Signal, daily: boolean): Promise<boolean> => {
    const { org } = run;
    if (findings.find(org, s.key) !== undefined) return false;
    const outcome = await run.act({
      key: daily ? `${s.key}:${run.ws.day}` : s.key,
      text: s.title,
      reason: s.detail,
      do: async () => {
        await findings.report(
          {
            org,
            ...(s.project === undefined ? {} : { project: s.project }),
            source: "setup",
            title: s.title,
            detail: s.detail,
            evidence: [],
            severity: s.severity,
            dedupeKey: s.key,
          },
          { kind: "captain", org },
        );
        return { outcome: "asked", undoNote: "A finding for you: dismiss it to undo" };
      },
    });
    return outcome === "asked";
  };

  /** Each run leaves one line in the log. */
  const summary = (run: ChoreRun, label: string, text: string) =>
    run.act({
      key: `${run.chore}:summary:${run.org}:${run.ws.day}`,
      text: `${label}: ${text}`,
      reason: "Each upkeep run leaves one line",
      do: async () => ({ undoNote: "A log line: nothing to undo" }),
    });

  return {
    async discover(run) {
      const u = ports.upkeep;
      if (u === undefined) return;
      const { org, ws } = run;
      const seen = new Set<string>();
      const found: Candidate[] = [];
      for (const term of (await u.profile(org)).slice(0, MAX_TERMS)) {
        run.check();
        for (const kind of ["mcp", "skill"] as const) {
          for (const c of await u.search(kind, term).catch(() => [])) {
            if (c.installed || seen.has(discoverKey(c))) continue;
            seen.add(discoverKey(c));
            found.push(c);
          }
        }
      }
      // Never twice: what was proposed, installed or turned down (a dismissed finding stays) is dropped.
      const fresh = found
        .filter((c) => findings.find(org, discoverKey(c)) === undefined && !run.done(discoverKey(c)))
        .toSorted((a, b) => (b.installs ?? 0) - (a.installs ?? 0))
        .slice(0, MAX_PROPOSALS);
      let proposed = 0;
      let installed = 0;
      for (const c of fresh) {
        run.check();
        const key = discoverKey(c);
        const what = c.kind === "mcp" ? "MCP server" : "skill";
        const why = `${c.title}: ${clip(c.description, 160)}${c.source === undefined ? "" : ` Source: ${c.source}`}`;
        if (ws.rules?.fullAccess === true && c.kind === "skill" && !off(run, "disc-install")) {
          const outcome = await run.act({
            key,
            text: `Installed the skill ${c.title}`,
            reason: `A low-risk skill that fits ${ws.name}'s projects. It is enabled for no agent. ${why}`,
            do: async () => {
              await u.installSkill(org, c);
              return { undoNote: `Remove it with skills.remove ${c.title}` };
            },
          });
          if (outcome === "done") installed += 1;
          continue;
        }
        if (off(run, "disc-propose")) continue;
        const outcome = await run.act({
          key,
          text: `Suggests the ${what} ${c.title}`,
          reason: why,
          do: async () => {
            await findings.report(
              {
                org,
                source: "setup",
                title: `Try the ${what} ${c.title}`,
                detail: `${why}\nInstalling it is your approval.`,
                evidence: [],
                severity: "info",
                dedupeKey: key,
              },
              { kind: "captain", org },
            );
            return { outcome: "asked", undoNote: "A finding for you: dismiss it to undo" };
          },
        });
        if (outcome === "asked") proposed += 1;
      }
      const parts = [
        ...(installed > 0 ? [`installed ${installed}`] : []),
        ...(proposed > 0 ? [`proposed ${proposed}`] : []),
      ];
      await summary(run, "Discover tools", parts.length === 0 ? "nothing new fits" : parts.join(", "));
    },

    async tidy(run) {
      const u = ports.upkeep;
      if (u === undefined) return;
      const { org } = run;
      let fixed = 0;
      let left = 0;
      if (!off(run, "tidy-retest")) {
        for (const c of await u.failingConnections(org)) {
          run.check();
          const outcome = await run.act({
            key: `tidy:retest:${c.id}:${run.ws.day}`,
            text: `Tested the connection ${c.name} again`,
            reason: "Its last test failed",
            do: async () => {
              if (await u.retest(c.id)) return { text: `The connection ${c.name} passes its test now` };
              throw new Error(`${c.name} still fails its test`);
            },
          });
          if (outcome === "done") fixed += 1;
          else if (outcome === "failed") {
            const s: Signal = {
              key: `tidy:connection:${c.id}`,
              title: `The connection ${c.name} keeps failing its test`,
              detail: "It failed again after the captain tested it. Fix its values or remove it.",
              severity: "low",
            };
            if (await file(run, s, false)) left += 1;
          }
        }
      }
      // Worktrees of done tasks: the cleanup chore removes the clean ones. Here the dirty ones are
      // named for the owner and never touched.
      for (const t of await ports.cleanable(org)) {
        if (t.dirty.length === 0 || off(run, "tidy-dirty")) continue;
        run.check();
        const s: Signal = {
          key: `tidy:dirty:${t.id}`,
          title: `${t.id} is done but its worktree has uncommitted changes`,
          detail: `${t.dirty.join("; ")}. Nothing is removed without you.`,
          severity: "low",
        };
        if (await file(run, s, false)) left += 1;
      }
      if (!off(run, "tidy-propose")) {
        let filed = 0;
        for (const s of await u.tidy(org)) {
          if (filed >= MAX_SIGNALS) break;
          run.check();
          if (await file(run, s, false)) {
            filed += 1;
            left += 1;
          }
        }
      }
      await summary(run, "Tidy up", line(fixed, left, "nothing to tidy"));
    },

    async health(run) {
      const u = ports.upkeep;
      if (u === undefined) return;
      let fixed = 0;
      let left = 0;
      for (const check of await u.health()) {
        if (check.ok) continue;
        run.check();
        if (check.fix !== undefined && !off(run, "health-fix")) {
          const label = check.fix.label;
          const outcome = await run.act({
            key: `health:fix:${check.id}:${run.ws.day}`,
            text: `Fixed the health check ${check.label}: ${label}`,
            reason: check.detail,
            do: async () => {
              const r = await u.healthFix(check.id);
              if (r.needsOwner) return { outcome: "asked", text: `${check.label} needs you: ${r.detail}` };
              if (!r.ok) throw new Error(r.detail);
              return { undoNote: "A fix majhi offers itself: nothing to undo" };
            },
          });
          if (outcome === "done") fixed += 1;
          if (outcome === "asked") left += 1;
          if (outcome === "done" || outcome === "asked") continue;
        }
        if (check.group === "majhi" && !off(run, "health-bug")) {
          const outcome = await run.act({
            key: `health:bug:${check.id}:${clip(check.detail, 80)}`,
            text: `Filed a bug on majhi: ${check.label} fails`,
            reason: check.detail,
            do: async () => {
              await u.reportBug(`Health check fails: ${check.label}`, `${check.id}: ${check.detail}`);
              return { outcome: "asked", undoNote: "A fix task in Private: close it to undo" };
            },
          });
          if (outcome === "asked") left += 1;
          continue;
        }
        const s: Signal = {
          key: `health:${check.id}`,
          title: `Health check fails: ${check.label}`,
          detail: check.detail,
          severity: "medium",
        };
        if (await file(run, s, false)) left += 1;
      }
      await summary(run, "Health sweep", line(fixed, left, "all checks pass"));
    },

    async checklist(run) {
      const u = ports.upkeep;
      if (u === undefined) return;
      const { ws } = run;
      let fixed = 0;
      let left = 0;
      for (const s of (await u.checklist(run.org)).slice(0, MAX_SIGNALS)) {
        run.check();
        if (await file(run, s, true)) left += 1;
      }
      // Starts wait for a slot of an account that has room.
      for (const s of await u.slots()) {
        if (s.waiting === 0 || s.free > 0) continue;
        run.check();
        const to = s.limit + 1;
        const base = `${s.account} has ${s.inUse} of ${s.limit} slots in use and ${s.waiting} ${s.waiting === 1 ? "start" : "starts"} waiting`;
        const key = `slots:${s.account}:${s.limit}`;
        if (s.limit >= MAX_ACCOUNT_SLOTS || !s.headroom) {
          const why =
            s.limit >= MAX_ACCOUNT_SLOTS
              ? `The captain does not raise it past ${MAX_ACCOUNT_SLOTS}`
              : "Its weekly use is high";
          const f: Signal = {
            key,
            title: `Agents wait for a slot on ${s.account}`,
            detail: `${base}. ${why}.`,
            severity: "info",
          };
          if (await file(run, f, true)) left += 1;
          continue;
        }
        if (ws.rules?.fullAccess !== true || off(run, "check-slots")) {
          const f: Signal = {
            key,
            title: `Raise the agent slots per account to ${to}?`,
            detail: `${base}, and it has room. Set agents at once per account to ${to} in Limits.`,
            severity: "info",
          };
          if (await file(run, f, true)) left += 1;
          continue;
        }
        const outcome = await run.act({
          key: `${key}:${run.ws.day}`,
          text: `Raised agents at once per account from ${s.limit} to ${to}: starts waited on ${s.account}`,
          reason: `${base}, and it has room`,
          do: async () => {
            await u.setAccountSlots(to);
            return { undoNote: `Set agents at once per account back to ${s.limit} in Limits` };
          },
        });
        if (outcome === "done") fixed += 1;
      }
      await summary(run, "Owner checklist", line(fixed, left, "nothing needs you"));
    },
  };
}

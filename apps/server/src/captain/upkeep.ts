import { createHash } from "node:crypto";
import { type CaptainChore, PRIVATE } from "@majhi/shared";
import { isDiskLow } from "../disk/guard.ts";
import { errorMessage } from "../errors.ts";
import { upperFirst } from "../machine/busy.ts";
import { sizeText } from "../tasks/folder-sweep.ts";
import type { CaptainPorts } from "./ports.ts";
import type { ChoreRun } from "./runner.ts";
import { type Candidate, MAX_ACCOUNT_SLOTS, type Signal, skillInstallInput } from "./upkeep-ports.ts";
import { coverageBrief } from "./watch-coverage.ts";

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
  "discover" | "tidy" | "health" | "checklist" | "watches"
>;

const clip = (s: string, n = 100) => (s.length <= n ? s : `${s.slice(0, n - 3)}...`);

/** What a rejected or proposed tool is remembered by. */
export function discoverKey(c: Pick<Candidate, "kind" | "id">): string {
  return `discover:${c.kind}:${c.id}`;
}

/** "fixed 2, 1 for you", or the words for nothing. */
/** The log key of a run's one summary line, and the test for it, so a page reads the run's result from that line. */
export const summaryKey = (chore: string, org: string, day: string): string =>
  `${chore}:summary:${org}:${day}`;
export const isSummaryKey = (key: string): boolean => key.split(":")[1] === "summary";

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
      key: summaryKey(run.chore, run.org, run.ws.day),
      text: `${label}: ${text}`,
      reason: "Each upkeep run leaves one line",
      do: async () => ({ undoNote: "A log line: nothing to undo" }),
    });

  return {
    /**
     * Wakes the captain to review the workspace's watch coverage whenever the facts it would reason from changed
     * (an environment, a watch, a connection, an incident). The same facts never wake it twice. The captain adds
     * the watches, one History line each; the chore only hands it the facts and the catalogue.
     */
    async watches(run) {
      const u = ports.upkeep;
      if (u?.watchCoverage === undefined || u.wakeCaptain === undefined) return;
      const { org, ws } = run;
      const facts = await u.watchCoverage(org);
      if (facts.projects.length === 0) {
        await summary(run, "Watch coverage", "no project to cover");
        return;
      }
      const digest = createHash("sha1").update(JSON.stringify(facts)).digest("hex").slice(0, 12);
      const outcome = await run.act({
        key: `watches:${org}:${digest}`,
        text: `Asked the captain to review watch coverage in ${ws.name}`,
        reason: "A project, a watch, a connection or an incident changed since the last review",
        do: async () => {
          u.wakeCaptain?.(org, coverageBrief(ws.name, facts));
          return { undoNote: "A request to the captain: nothing to undo" };
        },
      });
      await summary(
        run,
        "Watch coverage",
        outcome === "done" ? "asked the captain to review it" : "nothing changed",
      );
    },

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
        if (
          ws.rules?.fullAccess === true &&
          c.kind === "skill" &&
          skillInstallInput(c) !== undefined &&
          !off(run, "disc-install")
        ) {
          const outcome = await run.act({
            key,
            text: `Installed the skill ${c.title}`,
            reason: `A low-risk skill that fits ${ws.name}'s projects. It is enabled for no agent. ${why}`,
            do: async () => {
              try {
                await u.installSkill(org, c);
              } catch (err) {
                // A skill that fails to install (it does not validate, say) fails once, with its reason.
                // The finding is kept under the same key, so no later pass tries it again.
                const why = clip(errorMessage(err), 300);
                await findings.report(
                  {
                    org,
                    source: "setup",
                    title: `The skill ${c.title} could not be installed`,
                    detail: `${why}\nmajhi will not try it again. Dismiss this when you no longer need it.`,
                    evidence: [],
                    severity: "info",
                    dedupeKey: key,
                  },
                  { kind: "captain", org },
                );
                return {
                  outcome: "asked",
                  text: `Could not install the skill ${c.title}: ${why}`,
                  undoNote: "A finding for you: dismiss it to undo",
                };
              }
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
            failText: `Could not fix the connection ${c.name}`,
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
      // A secret request nobody answered for days: withdrawn when the task closed or the secret came another way.
      if (!off(run, "tidy-secrets")) {
        for (const r of await u.staleSecrets(org)) {
          if (r.obsolete === undefined) continue;
          run.check();
          const outcome = await run.act({
            key: `tidy:secret:${r.task}:${r.item}`,
            text: `Withdrew the secret request ${clip(r.label, 60)} in ${r.task}`,
            reason: r.obsolete,
            do: async () => {
              await u.withdrawSecret(r.task, r.item, r.obsolete ?? "");
              return { undoNote: "The agent can ask again" };
            },
          });
          if (outcome === "done") fixed += 1;
        }
      }
      // What waits for the owner still: the workspace's captain tries to fetch each through a connection first.
      // The wake is once per set of requests, so a day with the same requests wakes it once.
      const open = (await u.pendingSecrets?.(org)) ?? [];
      if (open.length > 0 && u.wakeCaptain !== undefined && !off(run, "tidy-secrets")) {
        const wake = u.wakeCaptain.bind(u);
        run.check();
        await run.act({
          key: `tidy:secrets-fetch:${run.ws.day}:${open.join(",")}`,
          text: `Asked the captain to try ${open.length} secret ${open.length === 1 ? "request" : "requests"} through the workspace's connections first`,
          reason: "A connection may produce the value, so the owner need not paste it",
          do: async () => {
            wake(
              org,
              `${open.length} secret ${open.length === 1 ? "request waits" : "requests wait"} for the owner: try to fetch each through a connection before they are asked`,
            );
            return { undoNote: "Nothing changed: the captain only looks" };
          },
        });
      }
      // Worktrees of done tasks: the cleanup chore removes the clean ones. Here the dirty ones are
      // named for the owner and never touched.
      const cleanable = await ports.cleanable(org);
      // One finding per task under a stable key. When a worktree is clean again or gone, its finding is resolved.
      const dirtyNow = new Set(cleanable.filter((t) => t.dirty.length > 0).map((t) => `tidy:dirty:${t.id}`));
      findings.settle(org, "setup", "tidy:dirty:", dirtyNow);
      for (const t of cleanable) {
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
      // The disk: Docker leftovers go on every run. When the disk is low, the folders of done and idle tasks
      // go now too, and when it stays low the owner gets one card with the biggest consumers.
      const disk = u.disk;
      if (disk !== undefined && !off(run, "tidy-disk")) {
        let freed = 0;
        const docker = await disk.docker().catch(() => undefined);
        if (docker !== undefined && (docker.images > 0 || docker.volumes > 0)) {
          run.check();
          const outcome = await run.act({
            key: `tidy:docker:${org}:${run.startedAt}`,
            text: `Removed ${docker.images} unused majhi images and ${docker.volumes} volumes of old tasks`,
            reason:
              "Nothing uses these images for a week, and the volumes belong to tasks done for a week. The build cache is never touched",
            do: async () => {
              const r = await disk.freeDocker();
              freed += r.bytes;
              return {
                text: `Removed ${r.images} unused Docker ${r.images === 1 ? "image" : "images"} (${sizeText(r.bytes)}) and ${r.volumes} ${r.volumes === 1 ? "volume" : "volumes"} of old tasks`,
                undoNote: "Docker images are pulled or built again when something needs them",
              };
            },
          });
          if (outcome === "done") fixed += 1;
        }
        const reading = disk.reading();
        if (reading?.low === true) {
          run.check();
          const gb = (reading.freeBytes / 1e9).toFixed(0);
          const outcome = await run.act({
            key: `tidy:disk:${org}:${run.startedAt}`,
            text: `The disk is low (${gb} GB free): freeing the folders of finished and idle tasks`,
            reason: "Under 15% or under 30 GB is free",
            do: async () => {
              const r = await ports.freeFolders?.(org);
              freed += r?.bytes ?? 0;
              return {
                text: `The disk was low (${gb} GB free). Freed ${sizeText(freed)} in all: ${sizeText(r?.bytes ?? 0)} in task folders`,
                undoNote: "Dependencies and build output come back with the next install or build",
              };
            },
          });
          if (outcome === "done") fixed += 1;
          const still = isDiskLow(reading.freeBytes + freed, reading.totalBytes);
          if (still && org === PRIVATE) {
            const plan = await disk.plan();
            const consumers = await disk.consumers();
            const free =
              plan.bytes > 0 ? ` Press Free ${sizeText(plan.bytes)} in Health to remove exactly this.` : "";
            const s: Signal = {
              key: `disk:low:${run.ws.day}`,
              title: `The disk is low: ${gb} GB free`,
              detail: [
                `Biggest: ${consumers.join(", ")}.`,
                plan.lines.length === 0
                  ? "Nothing more is safe to remove on its own."
                  : `One click would remove: ${plan.lines.join("; ")}.${free}`,
              ].join(" "),
              severity: "high",
            };
            if (await file(run, s, false)) left += 1;
          }
        }
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
            failText: `Could not fix the health check ${check.label}`,
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
        const busy = u.machineBusy?.();
        if (s.limit >= MAX_ACCOUNT_SLOTS || !s.headroom || busy !== undefined) {
          const why =
            s.limit >= MAX_ACCOUNT_SLOTS
              ? `The captain does not raise it past ${MAX_ACCOUNT_SLOTS}`
              : busy !== undefined
                ? upperFirst(busy)
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
      await summary(run, "Owner checklist", line(fixed, left, "nothing new"));
    },
  };
}

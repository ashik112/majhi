# Deploys v2: the AI plans, majhi guards

Replaces section 3 of `docs/design/ship-without-me.md` (deploy targets). Approved by the owner on 2026-10-07 after a survey of 32 real projects showed 9 deploy patterns no fixed target form covers (manual host jobs with inputs, merge-is-deploy, branch per environment, gitops tag bumps in another repo, image push with a platform pulling, jumphost helm, single VPS, platform git integration, laptop or console uploads).

Read `docs/briefs/quality-bar.md`. Owner rules that override everything here:

- **One source of truth.** No new tables, no new config files, no second copy of anything. Reshape what phase C built; delete what it replaces in the same change.
- **No BS tests.** Only the tests listed under Tests. Delete tests of removed code. Never run `scripts/ci.sh` or the whole suite; run typecheck and the tests of files you touched. No e2e changes.
- **Fast.** Smallest change that delivers the mockup. No speculative options.
- Generic sample names only in code, tests and docs (Acme, Globex, Northwind).

## Where each thing lives (all existing stores)

| Thing | Store | Notes |
|---|---|---|
| Environments of a project | the project config field that holds `DeployTarget[]` today | reshaped, see below |
| How a project deploys (jobs, inputs, order, parts, rollback, migrations, quirks) | a wiki page per project, kind `deploys`, written by the existing wiki writer | prose for the captain and the owner; corrections through `wiki.update` |
| A task's deploy plan | rows of the existing deploy records table, new state `planned`, plus `runs` and `seq` columns (one migration) | the task card is the existing derived deploy steps view |
| Deploy history, rollback, incidents | the same records | unchanged |
| Credentials | the workspace git account of the remote's host (`orgs.<id>.git_accounts`) | no connection pickers |
| Who may deploy | ship rules (`ShipPlanner.plan`), by tier | unchanged authority model |

## Data shape (`packages/shared/src/deploy.ts`)

```ts
export const DeployTierSchema = z.enum(["production", "staging"]);

// Replaces DeployTargetSchema. Env names may hold one "/" (GitLab style: app/kinbe, voice/bd-dhaka-1).
export const DeployEnvironmentSchema = z.object({
  env: EnvNameSchema,
  tier: DeployTierSchema.default("production"),   // unknown means production
  branch: LocalBranchSchema.optional(),           // pushing or merging to it deploys (host CI)
  check: z.url({ protocol: /^https?$/ }).max(500).optional(), // answers 2xx when up
});

// One run on a host, in the order a step needs them (a build, then the deploy job).
export const DeployRunStepSchema = z.discriminatedUnion("kind", [
  { kind: "github-workflow", remote, workflow: FileName, ref?: "base" | Ref, inputs? },
  { kind: "gitlab-job", remote, job: string, variables? },      // NEW: play a manual job on the commit's pipeline
  { kind: "gitlab-pipeline", remote, ref?, variables? },
  { kind: "vercel", connection, project, target },
  { kind: "ssh", connection, command },                          // owner only
]);

// DeployRecord gains: runs: DeployRunStep[] (1..8), seq: int (order inside a task's plan), note?: string.
// DEPLOY_STATES gains "planned" first. Moves: planned -> queued | held. A plan that is replaced deletes
// its own rows that are still planned (never started, nothing to keep).
```

`remote` names a git remote of the project; its host gives the provider and the workspace git account gives the token. Delete `DeployViaSchema`, `DeployVerifySchema`, `DeployRollbackSchema`, `DeployTargetSchema`, `viaLine`, and everything that only they used.

Rollback: run the runs of the newest `live` record of that env again at its commit (inputs included, so a `VERSION=1.8.3` comes back as it was). A record whose runs cannot be repeated says so and the incident asks the owner.

## Commands

- `projects.setEnvironments` {project, environments}: replaces `projects.setDeploy`, `projects.removeDeploy`, `projects.hideDeploySuggestion`. Captain may call it. **Rail:** only the owner may set a tier to `staging` or remove a production environment; the captain may add environments (always production) and set `branch` and `check`.
- `projects.planDeploy` {task, steps: [{project, env, runs, hold?: "migration", note?}]}: the captain writes the plan of a task; it replaces that task's `planned` rows. **Rails:** env must be one of the project's environments; `ssh` runs refused for the captain; a step with `hold` becomes `held` (owner releases with the existing hold flow).
- `projects.deploy`: runs a planned record by id, or (owner) an ad-hoc {project, env, runs}. Same follow, check, rollback, incident as today. The check is the environment's `check` URL for 60 s.
- `projects.deployView`: environments plus history. No suggestions.
- `projects.rollback`, `projects.holdDeploy`: unchanged in meaning.

## Rails in `ShipPlanner.plan` (pure, single decision)

- A deploy step's authority comes from the environment's tier, not its name. `deployStepOf` takes the tier.
- A merge or push into a branch that is some environment's `branch` is also a deploy of that environment: its authority is the stricter of Merge and that tier's Deploy cell.
- Every existing guard stays (checked head, secret scan, protected repos, hours, freezes, caps, presence).

## The captain

- When a task with deployable changes is ready to ship and has no plan, the existing ship chore asks the captain (one lane turn) to plan: it reads the project's `deploys` wiki page and the task's diff, then calls `projects.planDeploy`. Only what changed deploys; it names skipped parts in its room message.
- Planned rows then move by the ship rules like any deploy step.
- "Set up deploys for X" from the owner: the captain reads the project and writes `projects.setEnvironments`; the wiki writer writes the page.

## UI (approved mockup)

- Project page: the "Deploy targets" form, the add-target dialog and "Found in the project" are deleted. A read-only **Deploys** section: one row per environment (name, Production/Staging chip, what reached it last, lamp plus last version and time), header button **Deploy page** opens the wiki page. Rows reuse the Remotes row grid.
- Task room: the plan is one room card in the style of the ready bar (lamp, "Deploy plan", one-line summary, **Run** and **Change**), steps listed below with tier chip, runs and inputs, who; a held step shows the reason with **Allow**. While running the same card shows each step's state and **Stop**.
- Remotes section: the Host and SSH alias pickers are removed; each remote shows who it pushes as from the workspace git account. Only "Open MRs against" stays.

## Tests (only these)

1. `deployMayMove` with `planned` (pure).
2. Rails: captain cannot set `staging` or plan `ssh`; unknown env refused; merge into an environment's branch takes the stricter authority (pure `ShipPlanner.plan`).
3. `gitlab-job` provider: plays the job once, a retry finds it played (fake fetch).
4. SSH alias migration: a project's alias moves to the workspace git account and never overwrites a route already set.

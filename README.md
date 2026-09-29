# majhi

One place to run your AI coding agents, and stay in control.

majhi is a local workspace for running AI coding agents. You give it a task; it sets up the repo, branch and worktree, runs Claude Code or Codex on it, and streams everything the agent does, so you can watch, steer and stop it. Accounts, usage limits, secrets and approvals are handled for you, and nothing is pushed without your say.

Work is grouped into **orgs**: your own projects, clients and teams each get their own accounts, agents, repos and credentials, kept apart. A boss agent sets things up and runs majhi by conversation, and every change can be undone.

See `SPEC.md` for the full design and `docs/PROGRESS.md` for where the build stands.

## Run it

Needs Docker (OrbStack or Docker Desktop).

```sh
make up       # build, mount your workspace roots, start on http://127.0.0.1:7070
make doctor   # check config, mounts, git, SSH agent and disk space
make logs
make down
```

Config lives in `~/.majhi` (`majhi.yaml`). It is a git repo: every change majhi makes is a commit.

## Develop

Needs Node 22 and pnpm 11.

```sh
pnpm install
pnpm dev      # server on 127.0.0.1:7070, web on the Vite dev server
make ci       # Biome, typecheck, tests, builds, Playwright
```

## Files

- `SPEC.md`: what to build, architecture, phased plan
- `AGENTS.md` (and `CLAUDE.md`, same content): how coding agents work on this repo
- `design/ui-demo.dc.html`: the clickable UI prototype, as a reference
- `docs/PROGRESS.md` and `docs/DECISIONS.md`: progress log and decision log

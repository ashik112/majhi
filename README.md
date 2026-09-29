# majhi

A local, dockerized workspace for running AI coding agents across several companies. See `SPEC.md` for what it is and `docs/PROGRESS.md` for where the build stands.

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

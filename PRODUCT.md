# Product

<!-- impeccable:product-schema 1 -->

Written from SPEC.md section 1 and AGENTS.md. No interview was run; every fact below comes from those files.

## Platform

web

## Users

One developer, the owner. They work on several orgs at once (their own projects, clients and teams) and run AI coding agents (Claude Code, Codex) across many repos on GitHub, GitLab and Bitbucket. majhi is their main daily tool, open all day on a desktop screen.

## Product Purpose

majhi is a local, dockerized workspace where the owner runs AI coding agents for all of their orgs from one place, instead of opening separate CLIs by hand. Success: the owner creates a task in one sentence and a team of agents does it in isolated git worktrees, and the owner can run a full day of work without touching a terminal.

## Positioning

Owned core, reused parts: majhi orchestrates existing agents over ACP rather than building its own. Config lives as plain files in `~/.majhi`, versioned with git, and every change is a typed command the UI, the palette and the boss agent share.

## Operating Context

- Runs locally in Docker, bound to 127.0.0.1. Single user, no cloud.
- Projects live under workspace roots the owner picks (for example `~/Work`). Adding a root needs `make up` because container mounts are fixed at start.
- Built in phases (SPEC section 7). Phase 0 is the skeleton: pick roots, scan them for git repos, show them.

## Capabilities and Constraints

- Speed, clarity and reliability matter more than feature count.
- Keyboard-first. Dense where it helps, calm everywhere else.
- Dark theme first. IBM Plex Sans and IBM Plex Mono.
- The product is always named majhi (config `majhi.yaml`, folder `~/.majhi`).
- Visual reference: `design/ui-demo.dc.html`.

## Brand Commitments

- Name: majhi. Mark: amber rounded square with `mj` in mono.
- Voice: plain, direct, no em dashes, no filler.

## Product Principles

1. Speed and clarity over feature count. If a screen feels busy, simplify it.
2. Nothing leaves the machine without the owner's approval.
3. Files are the source of truth; the UI shows where they are.
4. Every control does something now. No placeholders for later phases.

<div align="center">

# majhi

### Run a team of AI coding agents for every client, from one desk.

Give a task in one sentence. A team of agents plans it, builds it, reviews it, and hands you one card to ship. Each client gets its own agents, accounts, repos and keys, kept fully apart.

[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue.svg)](LICENSE)
![Agents](https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Codex-8a63d2)
![Status](https://img.shields.io/badge/status-early%20access-f08c00)

<img src="docs/assets/screenshots/board.png" alt="The majhi board with tasks from four clients and every agent's status" width="100%">

</div>

---

*Majhi* (মাঝি) is the boatman who steers while others row. You steer. The agents row.

## Why it exists

AI agents can now write real code. Running them for real work is still a mess: one subscription per client, a different GitHub or GitLab login for each, SSH keys, tokens, and the constant risk of one client's code or secrets ending up in another client's work. Most tools give you one agent in one terminal and leave the rest to you.

majhi turns that into a desk you can run all day:

- **More work shipped, less babysitting.** Agents work in teams, resume on their own after sleep, network drops or usage limits, and only stop for you when a decision is really yours.
- **Clients never mix.** Every client is its own sealed workspace: its AI accounts, agents, repos, git identity, tokens, costs and memory. Every agent runs in its own container and sees only its own task.
- **You stay in control.** Nothing is pushed, merged or sent out without your click, unless you allow it for that client.

## What you can do

| | |
|---|---|
| **Hand off work in one sentence** | "Fix the export timeout in the API, from develop." The lead agent plans, splits the work, assigns builders and a reviewer, and reports back. |
| **Ship from one card** | Merge, squash or rebase into any branch, push, or open pull and merge requests on GitHub, GitLab and Bitbucket. Conflicts get fixed with one click. |
| **Run everything by asking** | The boss agent sets up clients, accounts, agents and repos when you describe them, and asks before anything risky. |
| **Use the logins you already have** | majhi finds your GitHub, GitLab and Bitbucket logins and SSH keys on your Mac and uses the right one per client. |
| **Know what it costs** | Tokens, cost and each account's usage limits, per client, project and agent. |
| **Never lose work** | Unshipped commits are counted before any task can close. Updates roll back on their own if something breaks. |

## A look inside

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/task-room.png" alt="A task room with the plan, the conversation and the branch" width="100%"></td>
    <td width="50%"><img src="docs/assets/screenshots/health.png" alt="Usage and limits for every AI account" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Every task is a room.</b> Plan, team, progress and branch, live.</sub></td>
    <td align="center"><sub><b>Limits per account.</b> See them before an agent hits them.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/orgs.png" alt="Clients as separate orgs with their own accounts and settings" width="100%"></td>
    <td width="50%"><img src="docs/assets/screenshots/new-task.png" alt="Starting a new task" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>One workspace per client.</b> Accounts, agents, repos and rules.</sub></td>
    <td align="center"><sub><b>One box to start work.</b> Pick the project and the team.</sub></td>
  </tr>
</table>

## Coming next

- **Autonomous mode.** Turn it on and the boss runs the desk like you would: picks work, sets up teams, fixes, builds and researches within the time and budget you set. You watch it live and can stop, pause or guide it at any time.
- **Background checks on every merge**, with a task opened automatically when something breaks.

## Use it

**Personal use is free.** Hobby projects, learning and your own work that earns nothing.

**Commercial use needs a license.** Freelance and client work, use inside a company, and agencies. majhi is in early access, and commercial licenses are available now: contact [@ashik112](https://github.com/ashik112).

### Install

You need Docker (Docker Desktop or OrbStack) on a Mac.

```sh
git clone https://github.com/ashik112/majhi.git && cd majhi
make up    # opens on http://127.0.0.1:7070
```

The first screen walks you through your folders, your first AI account and the boss agent. After that, updates are one click.

## How it works

```mermaid
flowchart LR
  you((You)) --> boss[Boss agent]
  boss --> acme & globex
  subgraph acme [Client: Acme]
    a1[Lead] --> a2[Builders] --> a3[Reviewer]
  end
  subgraph globex [Client: Globex]
    g1[Lead] --> g2[Builder]
  end
  a3 -->|Ship| arepo[(Acme repos)]
  g2 -->|Ship| grepo[(Globex repos)]
```

Each client is sealed off: its agents run in their own containers with only their own task, account and credentials. majhi runs on your machine. Agents use Claude Code and Codex with the accounts you connect.

<details>
<summary><b>For developers</b></summary>

majhi is TypeScript end to end: a Hono server, SQLite and a React app in one Docker compose file, plus a small helper on the Mac for logins, folders and updates. Agents speak the [Agent Client Protocol](https://agentclientprotocol.com).

```sh
pnpm install
pnpm dev          # server and web app
pnpm e2e:smoke    # quick end-to-end check
make ci           # everything CI runs
```

- [`SPEC.md`](SPEC.md): design and plan
- [`DESIGN.md`](DESIGN.md): visual system
- [`docs/PROGRESS.md`](docs/PROGRESS.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md): what is built and why
- [`AGENTS.md`](AGENTS.md): how agents work on this repo

Much of majhi was planned, built, reviewed and merged by agent teams running inside majhi.

</details>

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Commercial licenses: [@ashik112](https://github.com/ashik112).

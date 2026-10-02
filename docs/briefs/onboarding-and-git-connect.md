# Brief: onboarding and git connect

Git sign-in per workspace, remote repos, clone, new project, and a rebuilt first-run flow. A workspace is an org in code (`orgs.<id>` in majhi.yaml); Private is the built-in org `private`.

This brief is the contract. Two agents build from it in parallel:

- **Server and host:** `apps/server/src/gitConnect/` (stubs today) and `apps/host`.
- **Onboarding UI:** `apps/web/src/onboarding/`, against the stubs.

Neither changes a schema in `packages/shared` without saying so to the other.

## Read first

- `CLAUDE.md`: never push without approval, never pass another org's credentials, no secrets in logs, plain copy with no em dashes.
- The contract:
  - `packages/shared/src/git-signin.ts`: OAuth apps, sign-in flows, the needs-app steps, the grant secret
  - `remote-repos.ts`: remote repos, the clone job
  - `project-create.ts`: create, publish, connect a remote
  - `onboarding.ts`: step ids, `onboarding.status`
  - `host.ts`: `GitAuth`, `HostProgress`, and the jobs `openUrl`, `git.clone`, `git.lsRemote`, and `git.push` with `auth`
  - The command table entries in `commands.ts`
- Existing code this builds on:
  - `apps/server/src/orgs/gitAccount.ts` (`tokenRequest`, `checkToken`, `setGitAccount`) and `gitLogin.ts`
  - `apps/server/src/secrets/`
  - `projects.register` in `apps/server/src/projects/service.ts`
  - `apps/server/src/host/link.ts`
  - `apps/host/src/jobs.ts` and `gitPush.ts`

## Commands

| Command | Risk | Who | What |
|---|---|---|---|
| `onboarding.status` | read | anyone | Which steps are done, the next one, roots, host helper, workspaces with their git hosts and project counts |
| `git.oauthApps.get` | read | anyone | GitHub client ID, GitLab application IDs per host, Bitbucket key, majhi's origin and the Bitbucket callback URL. Never the secret |
| `git.oauthApps.set` | change | owner only | Save or remove one host's app. The Bitbucket secret goes to `secrets.age` |
| `git.signIn.start` | change | owner only | `needs-app` with setup steps, or a `device` code, or a `browser` authorize URL |
| `git.signIn.poll` | read | owner only | The flow's state |
| `git.signIn.cancel` | change | owner only | Ends a pending flow; nothing saved |
| `git.remoteRepos` | read | anyone | One page of repos the workspace's account sees, with search, each marked `here` |
| `git.remoteOwners` | read | anyone | Where the account can make a repo: itself, its organizations, groups or Bitbucket workspaces |
| `projects.clone` | change | always asks agents | Starts a clone job; answers at once |
| `projects.cloneStatus` | read | anyone | Clone jobs with progress |
| `projects.create` | change | always asks agents | Local only: folder, `git init` on `main`, README, first commit, registered |
| `projects.publish` | outbound | always asks agents | Makes the remote repo, sets `origin`, pushes |
| `projects.connectRemote` | outbound | always asks agents | Checks a pasted URL, sets the remote, pushes only when empty |

- "Owner only" means the command is in `AGENT_BLOCKED_COMMANDS`, so no agent gets it as a tool. The real handlers also refuse an `agent` actor, as `ownerOnlyPolicy` does.
- "Always asks agents" means it is in `ALWAYS_ASK` in `admin/service.ts`, so an agent's call is always an approval card.
- A risk class is per command, not per input. That is why the "Also create it on GitHub" box makes two calls: `projects.create` (change), then `projects.publish` (outbound).

**Events.** `signins` fires on every sign-in state change; the end of a flow also emits `orgs`, `config` and `secrets`. `clones` fires on every clone job change, at most every 500 ms while git reports progress. Both are `changed` topics: the web refetches `git.signIn.poll` and `projects.cloneStatus`. Query keys are in `apps/web/src/lib/queries.ts`. `onboarding` sits under `config`, so any config change refetches it.

## Where things live

- **OAuth apps.** majhi.yaml `git_apps` (`GitAppsConfigSchema`):
  - `github.client_id`
  - `gitlab.<host>.client_id`
  - `bitbucket.key`, and `bitbucket.secret` as a `secret:` reference

  Only public IDs and references are in the file. The Bitbucket consumer secret is saved with `SecretService.save` under the label `bitbucket oauth consumer`.
- **The token.** Saved in `secrets.age`, the same place pasted tokens and `mr_tokens` go today. A finished sign-in writes the org, exactly as `setGitAccount` does with a pasted token:
  - `git_accounts[]`: `{ host, account, token: secret:<ref> }`, plus `oauth: secret:<ref>` for GitLab and Bitbucket. Any SSH route the entry already has is kept.
  - `mr_tokens[kind]`: the same token ref.
  - The org identity, filled from the public profile only when the org has none.

  So Ship, MRs and push use it with no change.
- **The grant.** The `oauth` secret holds `OAuthGrant` JSON: `{ v, kind, host, clientId, refreshToken, expiresAt, scope }`.
  - majhi refreshes the access token when less than 10 minutes are left, and also on a 401.
  - It rewrites both secrets in place with `SecretStore.set` on the same names. majhi.yaml never changes, so no config commit is made every two hours.
  - GitHub OAuth App tokens do not expire, so a GitHub sign-in has no `oauth` secret.
- **Bitbucket OAuth tokens** have no `:`, so `mrs/hosts/bitbucket.ts` already sends them as `Bearer`. `tokenRequest` in `gitAccount.ts` turns a value with no `:` into `account:secret` Basic auth, so the sign-in check must build its own Bearer request (or teach `tokenRequest` about OAuth tokens). The clone username for a Bitbucket OAuth token is `x-token-auth`.
- **Sign-in flows and clone jobs** live in server memory. Both are lost on restart:
  - A pending sign-in just expires.
  - A clone in flight at a restart is not resumed. The helper's temporary folder is removed when its job ends either way (see Clone).

## Sign-in

### State machine

```
start ──► needs-app                       (no flow; set the app, start again)
start ──► pending ──► done
                  ├─► denied              (owner refused on the host page)
                  ├─► expired             (code or authorize link ran out, 15 min at most)
                  ├─► cancelled           (git.signIn.cancel, or a new start for the same org and host)
                  └─► failed { reason }   (anything else; reason never holds a token or code)
```

`pending` moves to exactly one end state and never back. Ended flows are kept for 10 minutes so the UI can read the outcome, then dropped.

### GitHub (device flow)

1. `git.signIn.start { org, kind: "github" }`. With no `git_apps.github`, answer `needs-app` with `gitAppSetup("github", "github.com", origin)`.
2. The server POSTs `https://github.com/login/device/code` with `client_id` and `scope=repo read:org workflow`.
   - `repo` covers private repos and creating repos.
   - `read:org` lists organization repos and owners.
   - `workflow` lets a push change `.github/workflows`.
3. The server asks the host helper to `openUrl` the `verification_uri`, and answers `device` with `userCode`, `verificationUri`, `expiresAt` and `opened`.
4. The server polls `https://github.com/login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds:
   - `authorization_pending`: keep polling.
   - `slow_down`: add 5 s to the interval.
   - `access_denied`: `denied`.
   - `expired_token`: `expired`.
5. With the token, call `GET https://api.github.com/user`. The `login` is the account.
6. Save (see "Where things live"). Compute `alsoUsedBy`: other orgs with a git account of the same host and account, compared case-insensitively. Compute `replaced`: this org's previous account on that host, when it was another one. Then `done`.

### GitLab (device authorization grant)

The same as GitHub, with these differences:

- **App lookup.** The app is `git_apps.gitlab[host]`. gitlab.com and any self-hosted host work only when an application ID is set for that host. Otherwise the answer is `needs-app` with `gitAppSetup("gitlab", host, origin)`.
- **Endpoints.** `POST https://<host>/oauth/authorize_device` with `client_id` and `scope=api`, then poll `POST https://<host>/oauth/token` with the device-code grant.
- **Code page.** `verificationUriComplete` is passed through when GitLab gives it.
- **User.** `GET https://<host>/api/v4/user`, field `username`.
- **Grant.** Save the `refresh_token` and `expires_in` as the grant. To refresh, call `POST /oauth/token` with `grant_type=refresh_token`, `refresh_token` and `client_id`. A public client sends no secret. GitLab rotates the refresh token on every refresh, so save the new one at once. A refresh answered `invalid_grant` makes the token `refused` (the UI offers to sign in again).

### Bitbucket (authorization code)

1. `git.signIn.start { org, kind: "bitbucket" }`. With no `git_apps.bitbucket`, answer `needs-app` with `gitAppSetup("bitbucket", "bitbucket.org", origin)`. It asks for `key` and `secret`.
2. Make a flow with a random one-time `state` (32 bytes, base64url).
3. The authorize URL is `https://bitbucket.org/site/oauth2/authorize?client_id=<key>&response_type=code&state=<state>`. `openUrl` it and answer `browser`.
4. Bitbucket sends the browser to `GET <origin>/oauth/bitbucket/callback?code&state`. The route is stubbed in `apps/server/src/gitConnect/routes.ts`; mount `OAuthRoutesDeps` in `AppDeps.oauth`.
   - The handler finds the pending flow by `state`. An unknown, used or expired `state` gets a plain page and nothing else.
   - It exchanges the code at `POST https://bitbucket.org/site/oauth2/access_token` (Basic `key:secret`, `grant_type=authorization_code&code=...`).
   - It calls `GET https://api.bitbucket.org/2.0/user` (Bearer; field `username`), saves, and answers a one-line page.
   - `error=access_denied` makes the flow `denied`.
5. To refresh, call the same endpoint with `grant_type=refresh_token`. Access tokens last 2 hours.

**The callback port.** The browser reaches majhi at the host-side port. Compose maps `127.0.0.1:${MAJHI_PORT:-7070}` to the container's 7070, and the server itself only sees its own listen port. Add `MAJHI_ORIGIN` (default `http://127.0.0.1:7070`) to the server env, and pass it from compose as `http://127.0.0.1:${MAJHI_PORT:-7070}`. Use it for `git.oauthApps.get.origin`, the setup values and the callback. The stub uses `DEFAULT_MAJHI_ORIGIN`.

### The needs-app steps (exact text)

`gitAppSetup(kind, host, origin)` in `git-signin.ts` is the single source. The server returns it and the UI shows it as is: the title, the link (opened with `openUrl`, else shown), numbered steps, copyable values, then the fields in `needs`. Summary:

- **GitHub:**
  1. Open github.com/settings/applications/new.
  2. Fill in the form with the values: name `majhi`, homepage `<origin>`, callback `<origin>/oauth/github/callback`.
  3. Click Register application.
  4. Tick Enable Device Flow and click Update application.
  5. Copy the Client ID and paste it here. majhi needs no client secret.
  6. An organization that limits OAuth apps approves majhi once.
- **GitLab:**
  1. Open `https://<host>/-/user_settings/applications`.
  2. Click Add new application and fill in the values: name `majhi`, redirect URI `<origin>/oauth/gitlab/callback`.
  3. Clear the Confidential box.
  4. Tick the `api` scope.
  5. Click Save application.
  6. Paste the Application ID. majhi needs no secret.
- **Bitbucket:**
  1. Open your workspaces and pick one you administer.
  2. Go to Settings, then OAuth consumers, and click Add consumer.
  3. Fill in the values: name `majhi`, callback URL `<origin>/oauth/bitbucket/callback`, URL `<origin>`.
  4. Tick the permissions Account: Read, Workspace membership: Read, Projects: Read, Repositories: Admin and Pull requests: Write.
  5. Click Save, then open the new consumer.
  6. Paste its Key and Secret.

## Remote repos

`git.remoteRepos { org, kind, host?, query?, page, perPage }` is called on the server with the org's token for that host: the `mr_tokens[kind]`, or the git account's `token` for that host. It never touches another org's token. Endpoints:

- **GitHub:**
  - With no query: `GET /user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page&page`.
  - With a query: `GET /search/repositories?q=<query> user:<account> fork:true` plus the account's orgs, or filter `/user/repos` pages. The builder picks one and records it in DECISIONS.
  - `nextPage` comes from the `Link` header.
- **GitLab:** `GET /api/v4/projects?membership=true&order_by=last_activity_at&search&per_page&page`, then `X-Next-Page`.
- **Bitbucket:** `GET /2.0/repositories?role=member&sort=-updated_on&q=name~"<query>"&pagelen&page`, then `next`.

`here` for each repo:

- `registered`: a project's remote URL points at the same host and full name. Compare normalized: lowercase host, `.git` dropped, ssh and https alike, SSH aliases resolved through `ssh.hosts`.
- Else `cloned`: a scanned repo under a root has such a remote, or the clone folder for this org exists.
- Else `none`.

A missing token answers `signed-out`. A refused token, after one refresh try, answers `refused`.

## Clone

### Path rule

`<root>/<org>/<folder>`:

- `root` is the first workspace root unless the call names another. Another root must be one of the configured roots, compared after `~` expansion.
- `org` is the workspace id. Private uses `private`, so it is `<root>/private/<repo>` (see DECISIONS).
- `folder` is the repo's name unless the call names another.

Paths are built with Node's `path` functions on resolved roots, never by string concatenation. Nothing assumes `/Users`.

### Refusals

`projects.clone` refuses, with a 409 and a plain sentence, when:

- the target exists and is not an empty folder;
- `<root>/<org>` exists and is itself a git repo, since that would nest a repo inside a repo;
- a project already has this repo as a remote (the answer names the project);
- the project id is taken (when one was given);
- the org has no credential for the host:
  - `via: https` needs a token;
  - `via: ssh` needs the org's git account on that host to have an SSH route;
- the host helper is not connected. The message asks the owner to start it, in the UI.

### Job states

```
queued ──► cloning { phase, percent } ──► registering ──► done { base }
   │              │                            │
   └──────────────┴────────────────────────────┴──► failed { reason }
```

- `queued`: made, waiting for the helper to take the job.
- `cloning`: the helper posts `HostProgress { id, phase, percent }` to `POST /api/host/progress`. That route is built; it calls `HostLink.progress`, which hands it to the `onProgress` given to `hostLink.call`. Phases follow git's `--progress` lines: `connecting`, `counting`, `compressing`, `receiving`, `resolving`, `checkout`.
- `registering`: the server calls the same code as `projects.register`, with:
  - `org`;
  - `path`;
  - `base` = the branch the helper checked out (the remote's default);
  - `remotes.origin` = the clone URL, with the host kind and SSH alias when cloned over SSH;
  - aliases from the input.
- `done` or `failed` end the job. `reason` is a plain sentence, never git's raw output and never a URL with credentials.

### Server vs host helper

| Step | Where |
|---|---|
| Check the input, the path rule, refusals, project id | server |
| Read the token from `secrets.age` (refresh first if near expiry) | server |
| `git clone --progress` with the credential, into `<parent>/.<folder>.majhi-clone-<id>`, then rename to `<folder>` | host helper (`git.clone`) |
| Remove the temporary folder on failure | host helper |
| Register the project, emit `projects`, `config`, `clones` | server |

The helper runs on the owner's computer, so the clone uses the owner's ssh config and agent for SSH. The repo appears in the container through the root mount at the same path.

### Credentials on the helper

These rules are platform-neutral (`GitAuth` in `host.ts`):

- **`token`.** Run git with:
  - `GIT_ASKPASS` set to a small askpass script the helper writes once into its own private folder (mode 700). The script prints `MAJHI_GIT_USERNAME` or `MAJHI_GIT_PASSWORD` from its environment.
  - Those variables set on the git child process only.
  - `-c credential.helper=` and `-c core.askPass=` overridden, so no system helper (osxkeychain, libsecret, wincred) is asked or stores anything.
  - `GIT_TERMINAL_PROMPT=0`.

  The URL is `https://<host>/<fullName>.git` with no user info. Usernames:
  - `x-access-token` for GitHub;
  - `oauth2` for GitLab;
  - `x-token-auth` for a Bitbucket OAuth token;
  - for a pasted Bitbucket API token (`email:token`), the part before `:` as the username and the part after as the password. Verify this against Atlassian's current docs before shipping.
- **`ssh`.** The URL is `git@<alias or host>:<fullName>.git`, using the org's git account SSH route for the host (`default` means the host name). Set `GIT_SSH_COMMAND=ssh -o BatchMode=yes`.
- **`none`.** For public repos only. Never the default.

The token travels server to helper once per job, inside the job params on the loopback long-poll, like `ssh.unlock`'s passphrase. It is never logged on either side. The helper's job log line names the method and id only, as today.

## New project

`projects.create { org, name, id?, root?, description?, aliases? }` runs on the server. The root is mounted at the same path, so the helper is not needed.

1. The path rule gives `<root>/<org>/<name>`. Refuse when it exists and is not empty, or when it would nest in a repo.
2. `mkdir -p`, then `git init -b main`.
3. Write `README.md` as `# <name>`, then a blank line and `description` when given.
4. Commit `Initial commit` as the org's identity. With no identity, use `majhi <majhi@majhi.local>`, as checkpoints do.
5. Register with `base: main`. The answer holds the project and the commit.

The web's "Also create it on GitHub/GitLab/Bitbucket" box is off by default. When ticked, the web calls `projects.publish` right after, and shows its approval card if one appears.

**Publish:** `projects.publish { id, kind, host?, owner?, name?, private=true, description? }`.

1. Refuse when the project has an `origin`, or the org has no token for the host.
2. Create the repo with the org's token:
   - GitHub: `POST /user/repos`, or `POST /orgs/<owner>/repos`.
   - GitLab: `POST /api/v4/projects` with `namespace_id` from the owner.
   - Bitbucket: `POST /2.0/repositories/<workspace>/<slug>` with `is_private`.
3. Set `origin`: SSH when the org's account on the host has an SSH route, else the https URL. Credentials never go in the saved URL.
4. Push the base branch with `setUpstream`:
   - over SSH from the server's git as today;
   - over https through the helper's `git.push` with `auth: token`.
5. Update the project's `remotes`. Log the push in the audit table.

**Connect a remote:** `projects.connectRemote { id, url, remote? }`.

1. Refuse a URL with user info (`CleanRemoteUrlSchema`) and a remote name that is already used.
2. `git.lsRemote` with the org's credential for the URL's host (token for https, SSH for ssh). Unreachable or refused answers a plain sentence and changes nothing.
3. Add the remote. If the remote is empty, push the base branch with upstream and answer `pushed`. Otherwise fetch it, push nothing, and answer `connected` with `detail`, for example: "The remote already has commits on main. Start a task to merge the two histories."

## Onboarding

### Steps, in order

| id | Title | Done when (`onboarding.status`) |
|---|---|---|
| `welcome` | Welcome | majhi.yaml loads with at least one root. This step sets the project folder (one suggested root from `fs.suggestRoots`, one click, "Choose another" opens the folder browser). Every other step writes majhi.yaml, which needs a root first |
| `account` | AI account | An account passed its health check (cached status) |
| `workspaces` | Workspaces | An org other than Private exists. Private-only owners skip it |
| `git` | Git accounts | Every workspace that has projects, or is not Private, has a token on at least one host |
| `projects` | Projects | At least one project is registered |
| `boss` | Captain | A valid root agent is the captain |
| `finish` | Arrive | `welcome`, `account` and `boss` are done |

The projects step has three ways in:

- **On this computer:** today's scan, with Register.
- **From GitHub, GitLab or Bitbucket:** `git.remoteRepos`, then `projects.clone`.
- **New project:** `projects.create`, then optionally `projects.publish`.

### Types

- `OnboardingStepId` and `ONBOARDING_STEP_IDS` are in `@majhi/shared`.
- `apps/web/src/onboarding/model.ts` types `SetupStepId` as `OnboardingStepId | "roots"`. `roots` is the old id of `welcome`; map it with `onboardingStepId()`.
- `reopenOnboarding("roots")` (Hub setup) and `reopenOnboarding("boss")` keep working.

### Skip and come back

Every step has Skip.

- Skipped ids are kept per browser, as `skip.ts` does today. Make it a set of ids instead of one flag.
- The gate opens onboarding at `onboarding.status.next` unless that step is skipped. It then tries the next step that is neither done nor skipped.
- Hub setup lists the not-done steps with an Open button. That button calls `reopenOnboarding(id)`, which clears that step's skip.
- First run (no majhi.yaml) always starts at `welcome`.

### UI notes

- **Git step.** Lists workspaces from `onboarding.status.workspaces`. Each has a "Sign in to GitHub / GitLab / Bitbucket" button:
  - `needs-app` shows the setup card from `setup`.
  - `device` shows the code large with a copy button, the page link (always shown; "Opened in your browser" when `opened`), and a countdown to `expiresAt`.
  - `browser` shows the link the same way.
  - `done` shows "Signed in as <account>". When `alsoUsedBy` is not empty, add the warning: "<account> is also used by <workspaces>. Work in both can reach the same repos."
- **Copy names no operating system.** Use "on this computer", never "on this Mac", in all new strings.

## Security rules

1. A token is saved for one org only, and only the org named in the call. `alsoUsedBy` warns but never copies a token between orgs.
2. A token never appears in a URL (clone, push, remote config, open page), a log line, an error, an audit row's input (redact as today), the room, TASK.md, or an agent's environment. Agent runs keep getting only what `runs/` gives them today.
3. The device `userCode` and the Bitbucket `state` are not secrets on their own, but are never logged with the token. The `code` from the callback is never logged or shown.
4. The Bitbucket consumer secret and every grant live in `secrets.age`. majhi.yaml holds only public IDs and `secret:` references. Nothing goes in the repo.
5. The callback route takes only `GET` with a known, unused, unexpired `state`. Each state is single-use, and the flow ends on first use. The answer page has no script and echoes no input.
6. Clone, publish and connect use the org's own credential, and never a system credential helper or another org's token.
7. Sign-in and the OAuth apps are owner only. Clone, create, publish and connect from an agent always ask. Publish and connect are outbound and follow the policy's outbound mode.
8. Text from a remote (repo names, descriptions, README) is data. It is shown escaped and never sent to an agent as an instruction.
9. Autonomous mode: `git.oauthApps.set` and the sign-in commands are blocked for agents. `projects.publish` and `projects.connectRemote` from an autonomous caller follow "every other outbound call is left for the owner".

## Other platforms

Nothing in this contract assumes macOS:

- Host jobs are plain git, Node `path`, and `openUrl`.
- `openUrl` uses `open` on macOS, `xdg-open` on Linux, and `wslview` (else `explorer.exe`) on WSL2.
- When the helper is missing, the UI shows the link to click.

Existing host helper features that are macOS-only today:

| Feature (apps/host) | macOS today | Linux | Windows (WSL2) |
|---|---|---|---|
| Start at login (`scripts/host.sh`) | LaunchAgent plist, `launchctl` | systemd user unit (`systemctl --user`) | systemd in WSL (`[boot] systemd=true`), or a Task Scheduler entry that runs `wsl.exe` |
| Secrets key backup (`keychain.ts`) | `security` and the login Keychain | Secret Service via `secret-tool` (libsecret) | Windows Credential Manager via `cmdkey` or PowerShell, through `powershell.exe` |
| SSH passphrases (`ssh.ts`) | `ssh-add --apple-use-keychain` and `--apple-load-keychain` | `ssh-add` once per session, or a keyring-backed agent (gnome-keyring, KeePassXC) | Same as Linux inside WSL, or the Windows OpenSSH agent through `npiperelay` |
| SSH agent socket (`ssh.ts`, `gitLogins.ts`, compose) | `launchctl getenv SSH_AUTH_SOCK`; Docker mounts `/run/host-services/ssh-auth.sock` | `$SSH_AUTH_SOCK` from the session; bind-mount that path | `$SSH_AUTH_SOCK` inside WSL; Docker Desktop's WSL backend mounts the same `/run/host-services/ssh-auth.sock` |
| Notifications (`notify.ts`, `main.ts`) | `osascript`, `terminal-notifier` for clicks | `notify-send` (libnotify); clicks with `--action` | `wsl-notify-send`, or a PowerShell toast through `powershell.exe` |
| Laya decisions (`laya.ts`) | `laya-mlx` on Apple silicon, macOS 14+ | Not available (MLX is Apple only); a CPU or CUDA build, or a hosted provider | Same as Linux |
| Open in editor (`editor.ts`) | `code` / `cursor` CLI, else `open -a` | `code` / `cursor` CLI only | `code` / `cursor` from WSL (Remote WSL) |
| Docker runtime detection (`startup.ts`, `paths.ts`) | Opens OrbStack or Docker Desktop; PATH adds their bin folders | `docker` from the distro (Docker Engine, Podman with docker CLI); `systemctl start docker` | Docker Desktop with the WSL backend, or Docker Engine inside WSL |
| Saved https logins (`gitPush.ts`: `git credential fill`) | osxkeychain helper | libsecret or the git-credential-manager | git-credential-manager (Windows) |
| Home paths | `/Users/<owner>` | `/home/<owner>` | `/home/<owner>` in WSL; `/mnt/c/...` roots work but are slow |

## Build order

1. **Server: OAuth apps and the origin.** `git.oauthApps.get/set` and `MAJHI_ORIGIN`. Test the config write and that the secret is saved and never returned.
2. **Server: sign-in.**
   - A flow store with the state machine, as a pure module.
   - GitHub and GitLab device flows behind an injectable `fetch`.
   - Save through the existing secret and org writers, plus `alsoUsedBy` and `replaced`.
   - GitLab refresh.
   - Tests: the state machine, `slow_down`, denied and expired, saving only to the named org, the token never in the result or logs, refresh rotation.
3. **Server: the Bitbucket callback.** Single-use `state`, code exchange, refresh. Tests: unknown and reused state, and no echo.
4. **Host helper.** `openUrl`, `git.clone` (askpass, temp folder, progress parsing, cleanup), `git.lsRemote`, and `git.push` with `auth`. Also post progress from `client.ts` and wire `runJob`'s `sendProgress`. Tests:
   - Clone against a local bare repo served over `file://`, plus an askpass unit test.
   - Cleanup on failure.
   - The token never in argv or the log.
5. **Server: remote repos and owners.** Host clients behind injectable `fetch`. Tests: paging and `here` matching (URL normalization).
6. **Server: clone jobs.** Path rule, refusals, job states, registering. Tests: the path rule (Private, a second root, nesting), refusals, state transitions, and no folder left on failure.
7. **Server: create, publish, connect.** Tests: create in a temp root, publish with a fake host and a local bare remote, connect to an empty and a non-empty remote.
8. **Server: `onboarding.status`.**
9. **Web, in parallel from step 1:** the new step list, the per-step skip set, the git step, the projects step's three tabs, clone progress, and the new-project form with the publish box.

## Open questions

1. **Private clone path.** `<root>/private/<repo>` was chosen for one rule and no clash with workspace folders. Owners who keep personal repos directly in a root may prefer `<root>/<repo>`. That is cheap to change before the first release.
2. **A shared GitHub OAuth App.** Should majhi ship one public client ID so GitHub needs no setup? Device flow needs no secret, so it is safe to publish. It would be registered by the majhi project, not the owner. The same question applies to gitlab.com.
3. **Self-hosted GitLab version.** The device authorization grant needs a recent GitLab. Find the minimum version, and decide whether the needs-app text should state it.
4. **Bitbucket OAuth consumers.** Atlassian retired app passwords in June 2026. Confirm OAuth consumers, the `x-token-auth` git username, and the permission names are still current. Also confirm the username for a pasted API token.
5. **GitHub search with organizations.** `search/repositories` limited to the account and its organizations, or client-side filtering of `/user/repos`. Results and rate limits differ.
6. **`alsoUsedBy` policy.** Today the token is saved and the UI warns. Should a second workspace on the same account need a confirm step instead?
7. **Clone resume.** In-memory jobs are lost on a server restart. Is a SQLite row worth it so the UI can say "Interrupted, clone again"?
8. **GitHub Enterprise Server** is not covered (`git_apps.github` is github.com only).
9. **Signing out.** There is no revoke command here. `orgs.removeGitAccount` removes the account but keeps the secret. Should sign-in add a `git.signOut` that also revokes the token at the host?

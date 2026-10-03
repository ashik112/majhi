# Brief: onboarding and git connect

Git sign-in per workspace, remote repos, clone, new project, and a rebuilt first-run flow. A workspace is an org in code (`orgs.<id>` in majhi.yaml); Private is the built-in org `private`.

This brief is the contract. Two agents build from it in parallel:

- **Server and host:** `apps/server/src/gitConnect/` (built) and `apps/host` (built).
- **Onboarding UI:** `apps/web/src/onboarding/`, against the stubs.

Neither changes a schema in `packages/shared` without saying so to the other.

## Read first

- `CLAUDE.md`: never push without approval, never pass another org's credentials, no secrets in logs, plain copy with no em dashes.
- The contract:
  - `packages/shared/src/git-signin.ts`: sign-in flows, the paste-a-token steps (`gitTokenHelp`), the grant secret, the optional device-flow apps
  - `remote-repos.ts`: remote repos, the clone job
  - `project-create.ts`: create, publish, connect a remote
  - `onboarding.ts`: step ids, `onboarding.status`
  - `host.ts`: `GitAuth`, `HostProgress`, and the jobs `openUrl`, `git.cliLogin`, `git.cliLoginCancel`, `git.clone`, `git.lsRemote`, and `git.push` with `auth`
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
| `git.oauthApps.get` | read | anyone | The optional device-flow apps: GitHub client ID, GitLab application IDs per host |
| `git.oauthApps.set` | change | owner only | Save or remove one host's device-flow app |
| `git.signIn.start` | change | owner only | A `device` code (gh), a `browser` page (glab), or `paste` with a reason |
| `git.signIn.token` | change | owner only | Checks a pasted token with the host and saves it like a sign-in (Bitbucket: with the Atlassian email) |
| `git.signIn.poll` | read | owner only | The flow's state |
| `git.signIn.cancel` | change | owner only | Ends a pending or confirming flow and stops its CLI; nothing saved |
| `git.signIn.confirm` | change | owner only | Saves a sign-in whose account other workspaces use, after the owner said yes |
| `git.signOut` | change | owner only | Removes the workspace's token and grant for a host, revoking it where the host allows |
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

- **The token.** Saved in `secrets.age`, the same place pasted tokens and `mr_tokens` go. A finished sign-in (browser or pasted) writes the org, exactly as `setGitAccount` does with a pasted token:
  - `git_accounts[]`: `{ host, account, token: secret:<ref> }`, plus `oauth: secret:<ref>` for a GitLab sign-in through glab. Any SSH route the entry already has is kept.
  - `mr_tokens[kind]`: the same token ref.
  - The org identity, filled from the public profile only when the org has none.

  So Ship, MRs and push use it with no change.
- **The grant.** The `oauth` secret holds `OAuthGrant` JSON: `{ v, kind, host, clientId, refreshToken, expiresAt, scope }`. Only GitLab has one.
  - majhi refreshes the access token when less than 10 minutes are left, and also on a 401, with `POST https://<host>/oauth/token` (`grant_type=refresh_token`, `refresh_token`, `client_id`). For a glab sign-in the client ID is glab's public one (`GLAB_CLIENT_ID`), which is what glab itself refreshes with.
  - It rewrites both secrets in place with `SecretStore.set` on the same names. majhi.yaml never changes, so no config commit is made every two hours.
  - GitHub tokens from gh do not expire. A pasted token has no grant.
  - A `bitbucket` grant from an older majhi is not refreshed: it reads as refused and the UI offers to sign in again.
- **Bitbucket API tokens** are saved as `email:token`. `bitbucketAuth` sends them to the REST API as Basic `email:token`, and git uses the static user name `x-bitbucket-api-token-auth` with the token.
- **CLI sign-ins** run on the owner's computer, in `<MAJHI_HOME>/git/<org>/<cli>` (mode 700), removed when the job ends. See "Sign-in through the CLI".
- **Sign-in flows** live in server memory. A pending sign-in is lost on restart and just has to be started again.
- **Clone jobs** live in majhi.db (`clone_jobs`, migration 115). A job a restart cut off is marked failed with "majhi restarted before the clone finished. Clone it again." At start majhi removes its temporary sibling, and the target only when majhi made that folder in that job and it is inside the job's root. A job whose project was registered before the restart is marked done. Retry is a new `projects.clone`.
- **Device-flow apps (optional).** majhi.yaml `git_apps` (`github.client_id`, `gitlab.<host>.client_id`) and `BUILT_IN_OAUTH_APPS` in `git-signin.ts` hold public client IDs for majhi's own device flow. Both are empty today, so that path is unused. An old `git_apps.bitbucket` loads and is ignored.

## Sign-in

### State machine

```
start ──► paste { reason }                (no flow; show gitTokenHelp, then git.signIn.token)
start ──► pending ──► done
token ──► pending ──┤
                    ├─► confirm ──► done    (the account is used by other workspaces: git.signIn.confirm)
                    │           ├─► cancelled / expired
                    ├─► denied              (owner refused on the host page)
                    ├─► expired             (the code ran out, 15 min at most)
                    ├─► cancelled           (git.signIn.cancel, or a new start for the same org and host)
                    └─► failed { reason }   (anything else; reason never holds a token or code)
```

`pending` moves to exactly one end state and never back. Ended flows are kept for 10 minutes so the UI can read the outcome, then dropped.

`git.signIn.start { org, kind, host? }` picks the way in, in this order:

1. **Bitbucket:** always `paste` with reason `bitbucket`.
2. **The host's CLI** (`gh` for github.com, `glab` for gitlab.com), when the host helper is connected. A CLI that is not installed answers `missing` and the next way is tried.
3. **majhi's device flow**, when `git_apps` or `BUILT_IN_OAUTH_APPS` has a client ID for the host.
4. **`paste`** with reason `self-hosted` (a GitLab other than gitlab.com), `no-cli` (the helper is there, the CLI is not) or `no-helper`.

GitHub Enterprise is not covered: start and token refuse a GitHub host other than github.com.

### Sign-in through the CLI (gh, glab)

1. The server makes a pending flow, then calls the host helper job `git.cliLogin { signIn, cli, org, host }` (timeout 16 minutes).
2. The helper (`apps/host/src/cliLogin.ts`):
   - answers `missing` when the CLI is not on its PATH;
   - wipes and makes `<MAJHI_HOME>/git/<org>/<cli>` (mode 700, and `git/` and `git/<org>/` too), with `config/` and `home/` inside;
   - runs the CLI with stdin closed and an environment it builds itself: `PATH`, `HOME` and the XDG folders inside `home/`, `GH_CONFIG_DIR` or `GLAB_CONFIG_DIR` set to `config/`, `BROWSER` and `GLAB_BROWSER` set to a small script that prints `MAJHI_LOGIN_URL <url>`, `NO_COLOR`, and only `TMPDIR`, `LANG` and `LC_ALL` from its own. No `GH_TOKEN`, `GITLAB_TOKEN` or other variable of the helper reaches the CLI.
     - gh: `auth login --hostname github.com --web --git-protocol https --skip-ssh-key --insecure-storage --scopes repo,read:org,workflow`. It prints `! One-time code (XXXX-XXXX) copied to clipboard` and `Open this URL to continue in your web browser: https://github.com/login/device`.
     - glab: `auth login --hostname gitlab.com --web --git-protocol https --insecure-storage`. It calls the browser script with GitLab's authorize page and waits for the browser on `localhost:7171`.
   - posts `HostLoginProgress { id, login: { url, code? } }` once the page (and gh's code) is in the output;
   - on exit 0 reads the token from `config/hosts.yml` (gh) or `config/config.yml` (glab, with `oauth2_refresh_token` and `oauth2_expiry_date`), never with `gh auth token`, which falls back to the keyring;
   - removes the folder whatever happened, and answers `done { token, refreshToken?, expiresAt? }`, `cancelled`, or a fixed sentence. The CLI's output never goes in a reply, an error or the log.
3. `start` waits up to 30 s for the page. It then fills the flow's `userCode` and `verificationUri` (gh) or `authorizeUrl` (glab), opens the page with `openUrl`, and answers `device` (gh) or `browser` (glab). A CLI that shows no page in time is stopped and the start fails with "gh did not show a sign-in page. Try again, or paste a token instead."
4. When the job ends with a token, the server checks it with the host's user API and saves it, exactly as below.
5. `git.signIn.cancel`, and a new start for the same org and host, call `git.cliLoginCancel { signIn }`, which kills the CLI's process group.

Why `--insecure-storage`: a per-workspace config folder does not isolate the system keyring, which is global. Plain storage in a private folder that lives only for the job keeps the owner's own gh and glab logins untouched. gh's `auth login` still deletes its unkeyed `gh:<host>` keyring entry while switching users; gh 2.40 and later read the per-user entry first, so the owner's own gh keeps working (see DECISIONS).

### Saving a token (all ways in)

1. Check the token with the host's user API: GitHub `GET https://api.github.com/user` (`login`), GitLab `GET https://<host>/api/v4/user` (`username`), Bitbucket `GET https://api.bitbucket.org/2.0/user` with Basic `email:token` (`username`).
2. Compute `alsoUsedBy`: other orgs with a git account of the same host and account, compared case-insensitively. Compute `replaced`: this org's previous account on that host, when it was another one.
3. When `alsoUsedBy` is empty, save (see "Where things live") and end `done`. Otherwise the flow moves to `confirm` with the account, `alsoUsedBy` and `replaced`, and the token waits in server memory only. `git.signIn.confirm` saves it and ends `done`; `git.signIn.cancel` or the flow's deadline drops it. The saved entry replaces this workspace's other accounts on that host (`replaced` names the old one); an SSH route is kept only when the account is the same.

### Pasted tokens (`git.signIn.token`)

`git.signIn.token { org, kind, host?, token, email? }` makes a flow and saves through the same steps, so a refused token ends `failed` with a plain reason and nothing is saved. Bitbucket needs `email`. The UI shows `gitTokenHelp(kind, host, org, reason)`:

- **GitHub:** `https://github.com/settings/tokens/new?description=majhi-<workspace>&scopes=repo,read:org,workflow`. Steps: open the page signed in as the workspace's account (majhi fills in the name and scopes), pick an expiration, click Generate token, paste it.
- **GitLab:** `https://<host>/-/user_settings/personal_access_tokens?name=majhi-<workspace>&scopes=api,read_user,write_repository` ([GitLab docs](https://docs.gitlab.com/user/profile/personal_access_tokens/), checked 2026-10-03). Steps: open the page, choose Legacy token if GitLab asks, set an expiration date, click Generate token, paste it. The form takes another host for a self-hosted GitLab.
- **Bitbucket:** an Atlassian API token with scopes. No admin access is needed. Steps, as [Atlassian's page](https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/) words them:
  1. Open https://id.atlassian.com/manage-profile/security/api-tokens.
  2. Click Create API token with scopes.
  3. Name it `majhi-<workspace>`, pick an expiry date, click Next.
  4. Choose Bitbucket as the app, click Next.
  5. Tick `read:user:bitbucket`, `read:workspace:bitbucket`, `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` (and `admin:repository:bitbucket` only for majhi to make repos), click Next.
  6. Click Create token, copy it, and paste it with the Atlassian account email.

  The REST API takes the email with the token as Basic auth; git takes `x-bitbucket-api-token-auth` with the token ([Using API tokens](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/), [API token permissions](https://support.atlassian.com/bitbucket-cloud/docs/api-token-permissions/)).

When the CLI is missing, the help says so in one line and links to installing it; it never blocks the paste.

### majhi's device flow (second path, unused today)

Only when `git_apps` or `BUILT_IN_OAUTH_APPS` has a client ID for the host:

- **GitHub:** POST `https://github.com/login/device/code` with `client_id` and `scope=repo read:org workflow`, then poll `https://github.com/login/oauth/access_token` with the device-code grant every `interval` seconds (`authorization_pending` keeps polling, `slow_down` adds 5 s, `access_denied` is `denied`, `expired_token` is `expired`).
- **GitLab:** `POST https://<host>/oauth/authorize_device` with `client_id` and `scope=api`, then poll `POST https://<host>/oauth/token`. It needs GitLab 17.3 or later; a host that answers 404 gets a sentence to paste a personal access token instead. The `refresh_token` and `expires_in` become the grant.

### Signing out

`git.signOut {org, kind, host?}` removes the token and grant and keeps the git account and its SSH route. It revokes on GitLab when there is a grant (`/oauth/revoke` with its client ID). Elsewhere it answers `revoke: "local"` with the host page to finish it: GitHub's authorized apps page for a gh token (`gho_`), GitHub's tokens page for a pasted one, GitLab's applications or access tokens page, Atlassian's API tokens page for Bitbucket.

## Remote repos

`git.remoteRepos { org, kind, host?, query?, page, perPage }` is called on the server with the org's token for that host: the `mr_tokens[kind]`, or the git account's `token` for that host. It never touches another org's token. Endpoints:

- **GitHub:**
  - With no query: `GET /user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page&page`. `nextPage` comes from the `Link` header.
  - With a query: majhi reads up to five pages of 100 of that list and filters by `owner/name` on the server, then pages the result itself. When the account sees more than 500 repos, it asks `GET /search/repositories?q=<words> in:name fork:true user:<account> org:<each org>` instead (see DECISIONS).
- **GitLab:** `GET /api/v4/projects?membership=true&order_by=last_activity_at&search&per_page&page`, then `X-Next-Page`.
- **Bitbucket:** the cross-workspace `GET /2.0/repositories` is gone from the current API reference, so majhi lists `GET /2.0/user/workspaces`, then `GET /2.0/repositories/<workspace>?role=member&sort=-updated_on&q=name ~ "<query>"&pagelen&page` for each (20 at most), merged and sorted by `updated_on`. `nextPage` is set when any workspace has a `next`. Owners for a new repo are the same workspaces.

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

`projects.clone` refuses, with a 409 and a plain sentence, when (also: a clone of the same repo or into the same folder already running):

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

- `queued`: made (a row in `clone_jobs`), waiting for the helper to take the job.
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

These rules are platform-neutral (`GitAuth` in `host.ts`, built in `apps/host/src/gitAuth.ts`):

- **`token`.** Run git with:
  - `GIT_ASKPASS` set to a small POSIX askpass script the helper writes at start into its own private folder `<MAJHI_HOME>/host` (mode 700). For a username prompt it prints `MAJHI_GIT_USERNAME`; for a password prompt it prints the file named by `MAJHI_ASKPASS_FILE`.
  - The token goes in that file only: a fresh folder per job (mode 700) under the helper's folder, the file mode 600, removed when git exits whatever happened. The token is never in argv or any environment variable, so `ps` and `/proc/<pid>/environ` never show it; only the owner's own processes could read the file, and only while the job runs.
  - `MAJHI_GIT_USERNAME` and `MAJHI_ASKPASS_FILE` set on the git child process only.
  - `-c credential.helper=` and `-c core.askPass=` overridden, so no system helper (osxkeychain, libsecret, wincred) is asked or stores anything.
  - `GIT_TERMINAL_PROMPT=0`.

  The URL is `https://<host>/<fullName>.git` with no user info. Usernames:
  - `x-access-token` for GitHub;
  - `oauth2` for GitLab;
  - for a Bitbucket API token (`email:token`), the static `x-bitbucket-api-token-auth` as the username and the part after `:` as the password (checked against Atlassian's "Using API tokens", 2026-10-03);
  - `x-token-auth` for a Bitbucket value with no `:` (an OAuth token from an older majhi).
- **`ssh`.** The URL is `git@<alias or host>:<fullName>.git`, using the org's git account SSH route for the host (`default` means the host name). Set `GIT_SSH_COMMAND=ssh -o BatchMode=yes`.
- **`none`.** For public repos only. Never the default.

The token travels server to helper once per job, inside the job params on the loopback long-poll, like `ssh.unlock`'s passphrase. It is never logged on either side. The helper's job log line names the method and id only, as today.

An empty remote repo cannot be cloned: the `git.clone` result needs a commit. The helper answers "The repo is empty, so there is nothing to clone. Use New project, then connect it to this repo."

**Ship and push with a signed-in token.** When a project's org has a token saved for exactly the remote's host and majhi pushes that remote over https through the helper, `git.push` carries `auth: token`, so the workspace's own account pushes and no saved login is asked. MRs and `orgs.gitStatus` read tokens through the same reader, which refreshes a GitLab sign-in first.

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
   - over SSH from the server's git as today (`git push --set-upstream origin <base>`);
   - over https through the helper's `git.push` with `auth: token`; the helper then points the branch's upstream at the remote with that URL.
5. Update the project's `remotes`. Log the push in the audit table (kind `push`, title "Push of <project>", the branch or the error; never the token).

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

- **Git step and workspace page.** The git step lists workspaces from `onboarding.status.workspaces`. Each row, and the workspace page's Git accounts section, shows the same panel (`apps/web/src/features/git-signin`): the accounts it works as with Sign out, then "Sign in with GitHub / GitLab / Bitbucket":
  - `device` shows gh's code large with a copy button, the page link (always shown; "Opened in your browser" when `opened`), and a countdown to `expiresAt`. The copy says GitHub asks to approve GitHub CLI.
  - `browser` shows glab's approve page the same way.
  - `paste` (and Bitbucket at once) shows the steps from `gitTokenHelp`, the prefilled link, and the fields: a host for GitLab, the Atlassian email for Bitbucket, the token.
  - `done` shows "Works as @<account>". When `alsoUsedBy` is not empty, add the warning: "<account> is also used by <workspaces>. Work in both can reach the same repos."
  - "Paste a token instead" is always one click away. On the workspace page the account rows keep their push, token and identity lines, with Sign out beside Remove.
- **Hub setup** lists the Git accounts step with Open, which brings the journey back at that step.
- **Copy names no operating system.** Use "on this computer", never "on this Mac", in all new strings.

## Security rules

1. A token is saved for one org only, and only the org named in the call. `alsoUsedBy` warns but never copies a token between orgs.
2. A token never appears in a URL (clone, push, remote config, open page), a log line, an error, an audit row's input (redact as today), the room, TASK.md, or an agent's environment. Agent runs keep getting only what `runs/` gives them today.
3. The device `userCode` is not a secret on its own, but is never logged with the token. A CLI's output is only searched for the page and the code; it never goes in a reply, an error, an event or a log.
4. Every token and grant lives in `secrets.age`. majhi.yaml holds only public IDs and `secret:` references. Nothing goes in the repo. A CLI sign-in's own token file lives only in its per-workspace folder, only while the job runs.
5. A CLI sign-in never reads or writes the owner's own CLI login: its own config folder, its own `HOME`, plain storage instead of the keyring, and an environment with nothing of the helper's.
6. Clone, publish and connect use the org's own credential, and never a system credential helper or another org's token.
7. Sign-in and the OAuth apps are owner only. Clone, create, publish and connect from an agent always ask. Publish and connect are outbound and follow the policy's outbound mode.
8. Text from a remote (repo names, descriptions, README) is data. It is shown escaped and never sent to an agent as an instruction.
9. Autonomous mode: `git.oauthApps.set`, `git.signIn.token` and the other sign-in commands are blocked for agents. `projects.publish` and `projects.connectRemote` from an autonomous caller follow "every other outbound call is left for the owner".

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

1. **Server: device-flow apps.** `git.oauthApps.get/set` (GitHub and GitLab client IDs only since 2026-10-03). Test the config write.
2. **Server: sign-in.**
   - A flow store with the state machine, as a pure module.
   - GitHub and GitLab device flows behind an injectable `fetch`.
   - Save through the existing secret and org writers, plus `alsoUsedBy` and `replaced`.
   - GitLab refresh.
   - Tests: the state machine, `slow_down`, denied and expired, saving only to the named org, the token never in the result or logs, refresh rotation.
3. **Server and host: CLI sign-in and pasted tokens** (2026-10-03, replaced the Bitbucket callback). `git.cliLogin` on the helper with a fake gh and glab on a temp PATH; `git.signIn.token` with a faked host API. Tests: the code and page parsed, the per-workspace folder, the token saved for the named workspace only and never in events, errors or output, cancel kills the CLI, a missing CLI falls back.
4. **Host helper.** `openUrl`, `git.clone` (askpass, temp folder, progress parsing, cleanup), `git.lsRemote`, and `git.push` with `auth`. Also post progress from `client.ts` and wire `runJob`'s `sendProgress`. Tests:
   - Clone against a local bare repo served over `file://`, plus an askpass unit test.
   - Cleanup on failure.
   - The token never in argv or the log.
5. **Server: remote repos and owners.** Host clients behind injectable `fetch`. Tests: paging and `here` matching (URL normalization).
6. **Server: clone jobs.** Path rule, refusals, job states, registering. Tests: the path rule (Private, a second root, nesting), refusals, state transitions, and no folder left on failure.
7. **Server: create, publish, connect.** Tests: create in a temp root, publish with a fake host and a local bare remote, connect to an empty and a non-empty remote.
8. **Server: `onboarding.status`.**
9. **Web, in parallel from step 1:** the new step list, the per-step skip set, the git step, the projects step's three tabs, clone progress, and the new-project form with the publish box.

## Settled questions (2026-10-02)

1. **Private clone path.** `<root>/private/<repo>`, kept.
2. **Shared OAuth apps.** Replaced on 2026-10-03: GitHub and GitLab sign in through gh and glab, whose apps are already registered. `BUILT_IN_OAUTH_APPS` stays empty; it only turns on majhi's own device flow if it ever gets IDs.
3. **Self-hosted GitLab.** A pasted personal access token (glab needs a client ID set per self-hosted host). The device flow, if an app is ever set for the host, needs 17.3 or later; an older host gets a sentence pointing at the paste box.
4. **Bitbucket.** Replaced on 2026-10-03: an OAuth consumer needs workspace admin, so Bitbucket takes an Atlassian API token with the email. The API token git user is `x-bitbucket-api-token-auth`. See "Pasted tokens".
5. **GitHub search.** Filter up to five pages of `/user/repos` on the server; the search API only past 500 repos.
6. **`alsoUsedBy`.** A `confirm` state and `git.signIn.confirm`: nothing is saved until the owner says yes.
7. **Clone resume.** Jobs in SQLite; a restart marks them failed and tidies their folders; retry is a new clone.
8. **GitHub Enterprise Server.** Not now. `git.signIn.start` for GitHub accepts github.com only and says to paste a token otherwise.
9. **Signing out.** `git.signOut {org, kind, host?}`, owner only. It revokes on GitLab when there is a grant (`/oauth/revoke` with its client ID). GitHub's revoke API needs the app's client secret, which majhi never has, and a pasted or Bitbucket API token is removed on the host's own page: there majhi removes the token and answers `revoke: "local"` with that page.

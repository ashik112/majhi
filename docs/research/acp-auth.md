# ACP adapters: auth, credentials, health checks

Research from 2026-09-29 against claude-agent-acp 0.84.0 and codex-acp 2.0.0. Sources are listed at the end.

I read the published npm contents on unpkg: claude-agent-acp 0.84.0, which pins claude-agent-sdk 0.3.284 (Claude Code 2.1.284), and codex-acp 2.0.0, which depends on @openai/codex ^0.158.0. I also read codex-acp's v2.0.0 source, openai/codex at rust-v0.158.0, the Claude Code docs and the ACP docs. No files were written. I didn't run `npm pack`, so nothing was created in /tmp and there was nothing to clean up. Main findings:

- **Binaries:** both adapters ship their own native CLI through optional npm dependencies.
- **Claude credential file:** Claude writes `.credentials.json` with an atomic rename that also takes a lock in its config dir. So a symlinked credential file is unsafe. This comes from a third party's analysis of the binary, not from source I could read.
- **Codex credential file:** Codex rewrites `auth.json` in place and follows symlinks. It has no lock between processes, only a reload-before-refresh guard.
- **ACP spec:** `logout` and Terminal Authentication are stable in ACP v1. `auth/status` is only a Draft RFD.
- **Health checks:** `claude auth status --json` and `codex login status` are free local checks. Each exits 0 when logged in and 1 when not.

## 1. Claude via claude-agent-acp 0.84.0
- **Binary:** the adapter uses the bundled SDK binary, not a `claude` on PATH. `claudeCliPath()` returns `CLAUDE_CODE_EXECUTABLE`, or else resolves `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`. On Linux it prefers the glibc build and falls back to musl. It throws if the binary is missing and tells you not to install with `--omit=optional` (acp-agent.js:626-662). The SDK is pinned at 0.3.284, which ships Claude Code 2.1.284 (sdk package.json).
- **Env:** the adapter passes `{...process.env, ...}` to the SDK (acp-agent.js:6581). Auth precedence is: cloud provider vars, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`, then Anthropic profiles, then the `/login` subscription (docs/authentication, "Authentication precedence"). `CLAUDE_CONFIG_DIR` relocates settings, history and `.credentials.json`. `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` plus `CLAUDE_CODE_OAUTH_SCOPES` lets `claude auth login` exchange a refresh token without a browser (env-vars.md:325-327).
- **Credential file:** on Linux it is `<config dir>/.credentials.json`, mode 0600 (docs/authentication, "Credential management"). The format is `{"claudeAiOauth":{accessToken, refreshToken, expiresAt, scopes, ...}}`, taken from anthropics/claude-code issues #72017 and #85262 (secondary). App state and OAuth account info go to `.claude.json` (claude-directory.md:1505). [INFERENCE] With `CLAUDE_CONFIG_DIR` set, that file moves to `$CLAUDE_CONFIG_DIR/.claude.json`.
- **Headless login:** run `claude auth login [--claudeai|--console]` or `/login`. The CLI prints a URL. When the browser can't reach the localhost callback, "common in … containers", the user pastes the code at `Paste code here if prompted` (docs/authentication). `claude setup-token` prints a one-year token that is never saved. Use it as `CLAUDE_CODE_OAUTH_TOKEN`; it can only make model requests.
- **ACP auth:** the adapter only advertises `type:"terminal"` methods, and only when the client sends `clientCapabilities.auth.terminal` or `_meta["terminal-auth"]`.
  - Normally it offers `claude-ai-login` (args `--cli auth login --claudeai`) and `console-login` (args `--cli auth login --console`).
  - If `NO_BROWSER`, `SSH_*` or `CLAUDE_CODE_REMOTE` is set, it offers `claude-login` (args `--cli`, which opens the TUI for `/login`) instead (1171-1238).
  - Gateway methods appear only with `auth._meta.gateway`.
  - `authenticate` handles only the gateway methods and throws for everything else (1401-1427).
  - `logout` is advertised as `auth.logout:{}` and runs `claude auth logout` (1697-1732).
  - The adapter pushes `_auth/status_update` with kind `account`, `api_key`, `gateway`, `external` or `none`, fed by `claude auth status --json` (auth-status.js).
  - When credentials are missing, turns fail with ACP `authRequired` (4170, 4656).
- **Config options:** `mode` (category mode), `model` (category model), `effort` (category thought_level) and `fast` (category model_config) (session-mode.js:4, session-model.js:2 and 182, session-effort.js:80-83, acp-agent.js:7370 and 7440).
- **Usage:** the adapter sends `usage_update {used, size, cost}`. On each SDK `rate_limit_event` it also sends `usage_update` with `_meta["_claude/rateLimit"]` (3960, 4772-4780). That payload is SDKRateLimitInfo: status `allowed`, `allowed_warning` or `rejected`, `resetsAt`, `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, overage variants), `utilization`, and overage fields (sdk.d.ts:5583-5592). The `/usage` slash command is backed by the SDK's experimental get_usage, which reports five_hour and seven_day utilization and `resets_at` (sdk.d.ts:4206-4298; acp-agent.js:101-143).

## 2. Codex via codex-acp 2.0.0
- **Binary:** the package depends on `@openai/codex ^0.158.0`. That package's native Linux x64 and arm64 builds are optional dependencies (package.json files). The adapter spawns `node @openai/codex/bin/codex.js app-server`, or `$CODEX_PATH app-server`, with the inherited env (CodexJsonRpcConnection.ts). `codex-acp cli …` runs the bundled CLI (index.ts:66-68). The `codex-acp login` subcommand runs `CODEX_PATH ?? "codex"` from PATH and opens a browser, so it doesn't suit a container (login.ts).
- **Env and home:** `CODEX_HOME` defaults to `~/.codex`. If set, it must already exist and is canonicalized (utils/home-dir). For the API-key method the adapter reads `CODEX_API_KEY` before `OPENAI_API_KEY` (CodexAcpClient.ts:281). `DEFAULT_AUTH_REQUEST` makes the adapter authenticate on its own when auth is required; without it, it returns `authRequired` (CodexAcpServer.ts:534-547). `NO_BROWSER` hides the browser ChatGPT method.
- **Credential file:** `$CODEX_HOME/auth.json`, fields `{auth_mode?, OPENAI_API_KEY, tokens:{id_token, access_token, refresh_token, account_id}, last_refresh, ...}`. The default store mode is `file`; the others are `keyring`, `auto` and `ephemeral` (storage.rs:39-65; config types.rs:115-125). An API-key login also writes `auth.json` (manager.rs:1021). Codex refreshes when the access token is within 5 minutes of expiry or `last_refresh` is more than 8 days old. On a 401 it reloads from disk, then refreshes (manager.rs:203-204, 1854-1857, 3005-3025).
- **Headless login:** `codex login --device-auth` prints `https://auth.openai.com/codex/device` and a one-time code that expires in 15 minutes (device_code_auth.rs:149-175). Other forms: `printenv OPENAI_API_KEY | codex login --with-api-key`, `codex login status`, `codex logout` (cli/main.rs:506-587). Browser login listens on localhost:1455, falling back to 1457 (server.rs:77-79).
- **ACP auth:**
  - `authMethods`: `api-key` (the key can come from `_meta["api-key"].apiKey`), `chat-gpt` unless `NO_BROWSER` is set (it opens a browser and waits for the localhost callback), `chat-gpt-device-code` only when the client supports URL elicitation, and `gateway` (CodexAuthMethod.ts).
  - There are no terminal methods.
  - `authenticate` is implemented, and `logout` is advertised as `auth.logout:{}` (CodexAcpServer.ts:393-415, 1038, 1079).
  - The adapter pushes `_auth/status_update` and answers the ext method `authentication/status` (CodexAcpServer.ts:450; AuthStatusMeta.ts).
- **Config options:** `model` (category model) and `reasoning_effort` (category thought_level) (ModelConfigOption.ts:6-83).
- **Usage:** `usage_update {used, size}` (CodexEventHandler.ts:1167). Rate limits from `account/rateLimits/updated` are stored per session but only shown by the `/status` text output. Each snapshot has `primary` and `secondary` windows `{usedPercent, windowDurationMins, resetsAt}`, plus credits and planType (CodexCommands.ts:284-288 and 530-550; RateLimitWindow.ts). [INFERENCE] The primary and secondary windows are the 5-hour and weekly limits.

## 3. Token refresh and a shared credential file
- **Claude:** the binary is closed source. A third-party analysis of the 2.1.282 binary reports three things (link-assistant/hive-mind#2296, secondary):
  - Refresh is serialized by `<configDir>/.oauth_refresh.lock`.
  - `.credentials.json` is written with a staging file plus `rename`, `O_NOFOLLOW`, and symlinks "refused".
  - Other processes notice changes through the file's mtime.
  
  The same issue shows that bind-mounting just the file leaves other processes on a stale inode with no shared lock, and rotated refresh tokens then invalidate each other. The rename-breaks-symlink pattern also appears for other Claude files (anthropics/claude-code#40857). **Conclusion:** don't symlink `.credentials.json`. Share the whole config dir.
- **Codex:** `FileAuthStorage.save` opens `auth.json` with truncate, write and create and writes in place. There is no rename and no `O_NOFOLLOW`, so it writes through a symlink (storage.rs:206-222). The refresh lock is an in-process `Semaphore(1)` and there is no file lock (manager.rs:2056, 2849). Two things lower the risk: the guarded reload skips a refresh when the file on disk has already changed, and a 401 triggers a reload first (2844-2880). The server can still reject with `refresh_token_reused` (1687). [INFERENCE] Logout and login delete the file with `remove_file`, which removes the symlink itself. The next save then creates a regular file in the agent home.

## 4. ACP authentication spec (v1)
- **Stable:** `initialize.authMethods`, where the type defaults to `agent`, and `authenticate(methodId)`, which returns `{}`. The `terminal` type is also stable: the client needs `clientCapabilities.auth.terminal`, runs the configured agent command plus the method's `args` and `env`, treats exit 0 as success, then reconnects. The client MUST NOT call `authenticate` for a terminal method. `logout` is gated on `agentCapabilities.auth.logout` (protocol/v1/authentication.md).
- **Status dates:** Terminal Authentication has been Completed since 2026-08-20 (rfds/updates.md:51-60). Logout has been Completed since 2026-05-22 (rfds/updates.md:246-250). Session usage updates are stable (llms.txt announcements).
- **Not stable:** `auth/status`, gated by `agentCapabilities.auth.status`, returns `{authenticated, message?}`. It is a Draft since 2026-07-21 and neither adapter implements it (rfds/get-auth-state.md).

## 5. Health checks
- **Claude:** `CLAUDE_CONFIG_DIR=… claude-agent-acp --cli auth status --json`. It exits 0 when logged in and 1 when not. The JSON includes `loggedIn`, `apiProvider`, `subscriptionType`, `apiKeySource`, `email`, `orgName` and `configDirectory` (cli-reference.md:27; auth-status.js). This is a local check that spends no tokens.
- **Codex:** `CODEX_HOME=… codex-acp cli login status`, exit 0 or 1 (cli/login.rs:443-507), is the local check. For a server-side check that spends no model tokens, use app-server `account/read {refreshToken:true}` and `account/rateLimits/read`, which also return the usage windows (CodexAcpClient.ts:207, 498).
- [INFERENCE] Both status commands only prove that credentials exist, not that they are still valid.

## Implications for majhi Phase 1
1. **Runner image:** Debian bookworm (glibc) with Node 22. Install `npm i -g @agentclientprotocol/claude-agent-acp@0.84.0 @agentclientprotocol/codex-acp@2.0.0` without `--omit=optional`, so the native `claude` and `codex` binaries for the image's arch are present. No separate `claude` or `codex` install is needed. Use `claude-agent-acp --cli` and `codex-acp cli`, or set `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`. `doctor` should call `--cli --version` and `cli --version`.
2. **Env per auth type, built from scratch:**
   - Claude subscription: `CLAUDE_CONFIG_DIR`.
   - Claude API key: `CLAUDE_CONFIG_DIR` plus `ANTHROPIC_API_KEY`.
   - Codex ChatGPT: `CODEX_HOME`, which must already exist.
   - Codex API key: `CODEX_HOME` plus `CODEX_API_KEY` (or `OPENAI_API_KEY`), plus either `DEFAULT_AUTH_REQUEST='{"methodId":"api-key"}'` or an ACP `authenticate` call. This persists the key into `auth.json`. [INFERENCE] If the key must stay only in `secrets.age`, test `cli_auth_credentials_store="ephemeral"`.
   - Never set `NO_BROWSER`, `SSH_*` or the cloud/OAuth variables unless you mean to.
3. **Login commands for the embedded terminal:**
   - `CLAUDE_CONFIG_DIR=~/.majhi/accounts/<id> claude-agent-acp --cli auth login --claudeai`. The user pastes the code back.
   - `CODEX_HOME=~/.majhi/accounts/<id> codex-acp cli login --device-auth`.
   - Always run login and logout against the account home, never an agent home. Don't send ACP `logout` from agent runs: it would clear the shared account.
4. **Linking credentials per agent:**
   - Claude: symlinking `.credentials.json` is unsafe (atomic rename and a lock that lives in the config dir). Use SPEC 5.2's fallback: one shared `CLAUDE_CONFIG_DIR` per account, with per-agent skills given through the prompt. The alternative is `claude setup-token` into `CLAUDE_CODE_OAUTH_TOKEN`, which never refreshes and needs no shared file.
   - Codex: a symlinked `auth.json` survives refreshes, but nothing locks it between processes. Keep it only if the Phase 1 two-agent concurrency test passes, and never run login or logout through an agent home.
5. **Health checks:** run `auth status --json` and `login status` for free local checks. After ACP `initialize`, read `_auth/status_update` for the plan and email. Take limits from Claude's `usage_update._meta["_claude/rateLimit"]` and Codex's `account/rateLimits`.

## Sources

- https://unpkg.com/@agentclientprotocol/claude-agent-acp@0.84.0/dist/acp-agent.js: claudeCliPath() (626-662), initialize authMethods (1150-1300), authenticate (1401), `claude auth status --json` probe (1530), logout → `claude auth logout` (1697-1732), usage_update and `_claude/rateLimit` (3177, 3960, 4772-4780), env spread (6581)
- https://unpkg.com/@agentclientprotocol/claude-agent-acp@0.84.0/dist/auth-status.js: `_auth/status_update` push extension; maps `claude auth status --json` fields
- https://unpkg.com/@agentclientprotocol/claude-agent-acp@0.84.0/dist/index.js: `--cli` passthrough to the native claude binary
- https://unpkg.com/@agentclientprotocol/claude-agent-acp@0.84.0/dist/session-model.js: model config option (id `model`, category `model`)
- https://unpkg.com/@agentclientprotocol/claude-agent-acp@0.84.0/dist/session-effort.js: effort config option (id `effort`, category `thought_level`)
- https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.284/sdk.d.ts: SDKRateLimitInfo (5583-5592); get_usage five_hour/seven_day (4206-4298)
- https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.284/package.json: optional native binaries per platform; claudeCodeVersion 2.1.284
- https://code.claude.com/docs/en/authentication: credentials path and 0600 mode, CLAUDE_CONFIG_DIR, precedence, setup-token, paste-code flow in containers
- https://code.claude.com/docs/en/cli-reference.md: `claude auth login/logout/status` (lines 25-27), setup-token (46)
- https://code.claude.com/docs/en/env-vars.md: CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_REFRESH_TOKEN
- https://raw.githubusercontent.com/agentclientprotocol/codex-acp/v2.0.0/src/CodexAuthMethod.ts: authMethods api-key / chat-gpt / chat-gpt-device-code / gateway
- https://raw.githubusercontent.com/agentclientprotocol/codex-acp/v2.0.0/src/CodexAcpServer.ts: initialize (393-415), ext `authentication/status` (450), checkAuthorization and DEFAULT_AUTH_REQUEST (534-547), logout (1079)
- https://raw.githubusercontent.com/agentclientprotocol/codex-acp/v2.0.0/src/CodexAcpClient.ts: authenticate flows; accountRead({refreshToken:true}) (207, 221)
- https://raw.githubusercontent.com/agentclientprotocol/codex-acp/v2.0.0/src/CodexJsonRpcConnection.ts: spawns bundled `codex app-server`, inherits env
- https://raw.githubusercontent.com/agentclientprotocol/codex-acp/v2.0.0/src/CodexEventHandler.ts: usage_update (1167); rate limits stored in session state only
- https://raw.githubusercontent.com/agentclientprotocol/codex-acp/v2.0.0/src/ModelConfigOption.ts: `model` (category model) and `reasoning_effort` (category thought_level)
- https://raw.githubusercontent.com/openai/codex/rust-v0.158.0/codex-rs/login/src/auth/storage.rs: AuthDotJson format; FileAuthStorage.save truncates and writes in place
- https://raw.githubusercontent.com/openai/codex/rust-v0.158.0/codex-rs/login/src/auth/manager.rs: in-process Semaphore refresh lock, guarded reload, 401 recovery, refresh_token_reused
- https://raw.githubusercontent.com/openai/codex/rust-v0.158.0/codex-rs/cli/src/login.rs: `--device-auth`, `--with-api-key` (stdin), `login status` exit codes
- https://agentclientprotocol.com/protocol/v1/authentication.md: stable authMethods, authenticate, terminal type, logout
- https://agentclientprotocol.com/rfds/get-auth-state.md: auth/status RFD (Draft since 2026-07-21)

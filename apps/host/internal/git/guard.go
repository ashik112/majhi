// Package git is the helper's git: clone, ls-remote, push, saved logins and the majhi checkout.
//
// guard.go is what keeps a repo from running commands in the helper's git, as majhi's own git does
// on the server (apps/server/src/git/git.ts). The helper pushes from the project's checkout, whose
// `.git/config` and hooks an agent outside a container can edit, and `ls-remote` reads the config
// of any repo it starts in.
//   - Every command: no hooks, no fsmonitor, no `ext::` remotes (GuardConfig). GIT_PROXY_COMMAND set
//     empty wins over every `core.gitProxy`, and GIT_SSH_COMMAND over `core.sshCommand` (GuardEnv).
//   - `ls-remote` names git's own upload-pack: git keeps the first `remote.<name>.uploadpack` it
//     reads, so only the command's option beats the repo's. `clone` reads no repo's config.
//   - A push: PushGuard.
//   - Commands that read the work tree (`status`, `checkout`, `worktree add`): the filter drivers the
//     repo's own config names are off (FiltersOff).
package git

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"majhi/host/internal/run"
)

const timeout20s = 20 * time.Second

// GuardConfig are `-c` options for every git command the helper runs.
var GuardConfig = []string{
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.fsmonitor=false",
	"-c", "protocol.ext.allow=never",
}

// GuardEnv returns the environment for every git command the helper runs.
func GuardEnv() map[string]string {
	return map[string]string{
		"GIT_PROXY_COMMAND": "",
		"GIT_SSH_COMMAND":   "ssh -o BatchMode=yes",
	}
}

// UploadPack is the option that makes `ls-remote` run git's own upload-pack.
const UploadPack = "--upload-pack=git-upload-pack"

// pushKeys is every key PushGuard reads, as git's own regexp (git matches it, not this program).
const pushKeys = `^(credential\.(.+\.)?helper|core\.(askpass|alternaterefscommand)|url\..+\.(insteadof|pushinsteadof))$`

// ListFilters are `git config` arguments that list every filter command, read without running anything.
var ListFilters = []string{"config", "-z", "--show-scope", "--get-regexp", `^filter\..+\.(clean|smudge|process)$`}

type configEntry struct {
	scope string
	key   string
	value string
	has   bool
}

// parseConfig reads what `git config -z --show-scope --get-regexp` printed, entry by entry.
func parseConfig(listed string) []configEntry {
	items := strings.Split(listed, "\x00")
	var entries []configEntry
	for i := 0; i+1 < len(items); i += 2 {
		scope, item := items[i], items[i+1]
		if at := strings.Index(item, "\n"); at >= 0 {
			entries = append(entries, configEntry{scope, item[:at], item[at+1:], true})
		} else {
			entries = append(entries, configEntry{scope: scope, key: item})
		}
	}
	return entries
}

// fromRepo is the repo's own config: its `.git/config`, its worktree config and what they include.
func fromRepo(e configEntry) bool { return e.scope == "local" || e.scope == "worktree" }

func isHelperKey(key string) bool {
	const prefix, suffix = "credential.", ".helper"
	if key == "credential.helper" {
		return true
	}
	return strings.HasPrefix(key, prefix) && strings.HasSuffix(key, suffix) && len(key) > len(prefix)+len(suffix)
}

func isRewriteKey(key string) bool {
	const prefix = "url."
	if !strings.HasPrefix(key, prefix) {
		return false
	}
	for _, suffix := range []string{".insteadof", ".pushinsteadof"} {
		if strings.HasSuffix(key, suffix) && len(key) > len(prefix)+len(suffix) {
			return true
		}
	}
	return false
}

// Setting is one `GIT_CONFIG_*` pair.
type Setting struct{ Key, Value string }

// FiltersOff are settings that turn off every filter driver the repo's own config names, from what
// ListFilters printed, as the server does (apps/server/src/git/git.ts `repoCommands`): a filter then
// converts nothing and is not required. The owner's global and system drivers (git-lfs, say) stay on.
func FiltersOff(listed string) []Setting {
	var out []Setting
	seen := map[string]int{}
	set := func(key, value string) {
		if at, ok := seen[key]; ok {
			out[at].Value = value
			return
		}
		seen[key] = len(out)
		out = append(out, Setting{key, value})
	}
	for _, e := range parseConfig(listed) {
		if !fromRepo(e) {
			continue
		}
		driver := e.key
		if dot := strings.LastIndex(e.key, "."); dot >= 0 {
			driver = e.key[:dot]
		}
		for _, name := range []string{"clean", "smudge", "process"} {
			set(driver+"."+name, "")
		}
		set(driver+".required", "false")
	}
	return out
}

// WithConfig adds settings in the command-line scope, after any already there, so they win over the
// repo's. Through the environment, not `-c`, which cuts a key at its first `=`: a driver's name may hold one.
func WithConfig(env map[string]string, settings []Setting) map[string]string {
	if len(settings) == 0 {
		return env
	}
	out := make(map[string]string, len(env)+2*len(settings)+1)
	for k, v := range env {
		out[k] = v
	}
	start := 0
	if had, err := strconv.Atoi(env["GIT_CONFIG_COUNT"]); err == nil && had > 0 {
		start = had
	}
	out["GIT_CONFIG_COUNT"] = strconv.Itoa(start + len(settings))
	for i, s := range settings {
		out["GIT_CONFIG_KEY_"+strconv.Itoa(start+i)] = s.Key
		out["GIT_CONFIG_VALUE_"+strconv.Itoa(start+i)] = s.Value
	}
	return out
}

// PushURLFor is the address a push goes to when the checkout's config has rewrites (`values` of its
// `insteadOf` and `pushInsteadOf`). None that matches: the address as it is. Matches that are only
// the beginning of the address are overridden by the address's own rewrite, which is longer. One
// that equals the address ties with it, and the repo's comes first, so the address gets a closing
// slash, which every git host takes and no value the repo planted for the plain address matches
// whole. It returns ok false when a value equals that one too: then nothing is pushed.
func PushURLFor(url string, values []string) (out string, override bool, ok bool) {
	var hits []string
	for _, v := range values {
		if strings.HasPrefix(url, v) {
			hits = append(hits, v)
		}
	}
	if len(hits) == 0 {
		return url, false, true
	}
	if !contains(hits, url) {
		return url, true, true
	}
	slashed := url + "/"
	if contains(values, slashed) {
		return "", false, false
	}
	return slashed, true, true
}

func contains(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}

// PushGuardResult is what a push runs with, on top of GuardConfig and GuardEnv.
type PushGuardResult struct {
	// URL is the address to push to: the one asked for, or it with a closing slash when a rewrite of the repo's equals it.
	URL string
	// Options go right after `push`.
	Options []string
	// Env is added to the push's: settings in `GIT_CONFIG_*`, and https only.
	Env map[string]string
}

// PushGuard is what a push from the checkout at path to url runs with, read with `git config`, which runs nothing:
//   - https only (`GIT_ALLOW_PROTOCOL`, which beats every `protocol.*.allow`), git's own receive-pack
//     and no push signing, so no `gpg.program` runs.
//   - `core.askPass` and `core.alternateRefsCommand` from the repo get the owner's value, else none.
//   - With the owner's login (ownLogin), a credential helper the repo adds is dropped by emptying
//     the list and adding the owner's back in order, so osxkeychain still answers. With a workspace
//     token, the auth environment empties the list already.
//   - A `url.<base>.insteadOf` or `pushInsteadOf` of the repo's that rewrites url is refused: git
//     cannot drop it, and it would hand the credential to another host.
//
// Nothing but the fixed settings when git cannot tell.
func PushGuard(runFn run.Func, path string, env map[string]string, url string, ownLogin bool) (PushGuardResult, error) {
	read := runFn("git", []string{"-C", path, "config", "-z", "--show-scope", "--get-regexp", pushKeys},
		run.Options{Env: env, Timeout: timeout20s})
	var entries []configEntry
	if read.Code == 0 {
		entries = parseConfig(read.Stdout)
	}
	var planted, owners []configEntry
	for _, e := range entries {
		if fromRepo(e) {
			planted = append(planted, e)
		} else {
			owners = append(owners, e)
		}
	}
	var rewrites []string
	for _, e := range planted {
		if isRewriteKey(e.key) && e.has {
			rewrites = append(rewrites, e.value)
		}
	}
	pushURL, override, ok := PushURLFor(url, rewrites)
	if !ok {
		return PushGuardResult{}, errors.New("The checkout's own git config rewrites the address of this push to another one, and majhi could not push around it. Ask the lead to remove the url.<base>.insteadOf lines from the checkout's git config.")
	}
	settings := []Setting{{"push.gpgSign", "false"}}
	if override {
		// Git rewrites with the longest matching value, and the first of equal ones. The address itself, as
		// its own rewrite, is longer than any value that is only its beginning, so the repo's rewrite never applies.
		settings = append(settings,
			Setting{"url." + pushURL + ".insteadOf", pushURL},
			Setting{"url." + pushURL + ".pushInsteadOf", pushURL})
	}
	done := map[string]bool{}
	for _, e := range planted {
		if done[e.key] || (e.key != "core.askpass" && e.key != "core.alternaterefscommand") {
			continue
		}
		done[e.key] = true
		own := ""
		for _, o := range owners {
			if o.key == e.key && o.has {
				own = o.value
			}
		}
		settings = append(settings, Setting{e.key, own})
	}
	if ownLogin {
		plantedHelper := false
		for _, e := range planted {
			if isHelperKey(e.key) {
				plantedHelper = true
			}
		}
		if plantedHelper {
			settings = append(settings, Setting{"credential.helper", ""})
			for _, e := range owners {
				if isHelperKey(e.key) && e.has {
					settings = append(settings, Setting{e.key, e.value})
				}
			}
		}
	}
	out := map[string]string{
		"GIT_ALLOW_PROTOCOL": "https",
		"GIT_CONFIG_COUNT":   strconv.Itoa(len(settings)),
	}
	for i, s := range settings {
		out["GIT_CONFIG_KEY_"+strconv.Itoa(i)] = s.Key
		out["GIT_CONFIG_VALUE_"+strconv.Itoa(i)] = s.Value
	}
	return PushGuardResult{URL: pushURL, Options: []string{"--receive-pack=git-receive-pack"}, Env: out}, nil
}

package git

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

// Pushes and reads saved logins on the owner's computer, where git's credential helper and `gh`
// live, because the server's container cannot reach them. Nothing here prompts, forces or returns a
// credential in a message: errors are fixed sentences, and git's own output is scrubbed of
// `https://user:pass@` forms.

const (
	pushTimeout       = 120 * time.Second
	credentialTimeout = 30 * time.Second
)

// PushDeps are what a push needs.
type PushDeps struct {
	Run  run.Func
	Home string
	// Path is the helper's PATH, already extended with the usual tool folders (so `gh` is found).
	Path string
	// Kind is the kind of thing at path: "file", "directory", or "" when there is nothing there.
	Kind func(path string) string
	// AuthEnv is the environment for a push with a workspace's own credential. Without it such a push is refused.
	AuthEnv func(auth protocol.GitAuth) (AuthEnv, error)
}

// WithoutUser is the URL without a user name: with a token, git takes the user name from majhi's askpass.
func WithoutUser(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.User = nil
	return u.String()
}

func isPlainHTTPS(raw string) bool {
	if strings.ContainsAny(raw, " \t\n\r\f\v\x00") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return false
	}
	if u.User != nil {
		if _, hasPassword := u.User.Password(); hasPassword {
			return false
		}
	}
	host := u.Hostname()
	if host == "" {
		return false
	}
	for _, r := range host {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-') {
			return false
		}
	}
	return len(u.EscapedPath()) > 1
}

// PushArgs are the `git push` arguments, or a refusal. Only an https URL and a plain branch are accepted.
func PushArgs(remote, branch string) ([]string, error) {
	if !isPlainHTTPS(remote) {
		return nil, errors.New("Only https remotes can be pushed from this computer.")
	}
	if !protocol.IsPlainBranch(branch) || strings.Contains(branch, "..") || strings.Contains(branch, "//") ||
		strings.HasSuffix(branch, "/") || strings.HasSuffix(branch, ".lock") || strings.ContainsAny(branch, ":+~^?*[\\") {
		return nil, errors.New("That is not a plain branch name. majhi never forces or deletes through a push.")
	}
	return []string{"push", "--quiet", remote, "refs/heads/" + branch + ":refs/heads/" + branch}, nil
}

func baseEnv(deps PushDeps) map[string]string {
	env := map[string]string{
		"PATH":                deps.Path,
		"HOME":                deps.Home,
		"GIT_TERMINAL_PROMPT": "0",
		"GCM_INTERACTIVE":     "never",
		"LC_ALL":              "C",
	}
	for k, v := range GuardEnv() {
		env[k] = v
	}
	return env
}

// Push is `git push <url> <branch>` in path with the owner's own git config, and no command the
// repo's config names (guard.go). It fails with a message safe to show.
func Push(deps PushDeps, params protocol.GitPushParams) error {
	token := params.Auth != nil && params.Auth.Kind == protocol.AuthToken
	remote := params.URL
	if token {
		remote = WithoutUser(params.URL)
	}
	args, err := PushArgs(remote, params.Branch)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(params.Path) || strings.Contains(params.Path, "\x00") {
		return errors.New("The path must be absolute.")
	}
	if deps.Kind(params.Path) != "directory" {
		return fmt.Errorf("There is no folder at %s on this computer.", params.Path)
	}
	if params.Auth != nil && params.Auth.Kind != protocol.AuthToken {
		return errors.New("The host helper pushes over https only. SSH pushes go from majhi itself.")
	}
	if token && deps.AuthEnv == nil {
		return errors.New("This host helper cannot push with a workspace's token.")
	}
	if key, err := RepoNetworkSetting(deps.Run, params.Path, baseEnv(deps)); err != nil {
		return err
	} else if key != "" {
		return NetworkSettingError(key)
	}
	guard, err := PushGuard(deps.Run, params.Path, baseEnv(deps), remote, !token)
	if err != nil {
		return err
	}
	// A rewrite in the checkout's config that equals the address is pushed around with a closing slash.
	if guard.URL != remote {
		for i, a := range args {
			if a == remote {
				args[i] = guard.URL
				break
			}
		}
	}
	env := baseEnv(deps)
	config := GuardConfig
	cleanup := func() {}
	// The token's folder goes whatever happens below, a panic included.
	defer func() { cleanup() }()
	if token {
		auth, err := deps.AuthEnv(*params.Auth)
		if err != nil {
			return err
		}
		env, config, cleanup = auth.Env, auth.Config, auth.Cleanup
	}
	// Whatever the repo says, a push never reaches into submodules.
	config = append(append([]string{}, config...), "-c", "push.recurseSubmodules=no")
	pushEnv := make(map[string]string, len(env)+len(guard.Env))
	for k, v := range env {
		pushEnv[k] = v
	}
	for k, v := range guard.Env {
		pushEnv[k] = v
	}
	full := []string{"-C", params.Path}
	full = append(full, config...)
	full = append(full, "push")
	full = append(full, guard.Options...)
	full = append(full, args[1:]...)
	result := deps.Run("git", full, run.Options{Env: pushEnv, Timeout: pushTimeout})
	cleanup()
	if result.Code == 0 {
		if params.SetUpstream {
			setUpstream(deps, params.Path, remote, params.Branch)
		}
		return nil
	}
	text := StripCredentials(result.Stderr + "\n" + result.Stdout)
	if result.Code == run.NoCode {
		return errors.New("git push did not finish in time on this computer.")
	}
	if token && IsHTTPSAuthFailure(text) {
		return fmt.Errorf("%s refused the workspace's token. Sign the workspace in again.", hostWithPort(params.URL))
	}
	if IsHTTPSAuthFailure(text) {
		who := "an account"
		if user := userOf(params.URL); user != "" {
			who = user
		}
		return fmt.Errorf("This computer has no saved login for %s on %s. Paste a token for the org, or use an SSH key.", who, hostWithPort(params.URL))
	}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	reason := strings.Join(lines, " ")
	if len([]rune(reason)) > 400 {
		reason = string([]rune(reason)[:400])
	}
	if reason == "" {
		reason = "no output"
	}
	return errors.New("git push failed: " + reason)
}

// setUpstream: after a push to a URL, the remote whose URL it is gets the branch as its upstream,
// and its tracking ref is moved to what was pushed. Nothing happens when no remote has that URL.
func setUpstream(deps PushDeps, path, remote, branch string) {
	opts := run.Options{Env: baseEnv(deps), Timeout: 20 * time.Second}
	git := func(args ...string) run.Result {
		full := append([]string{"-C", path}, GuardConfig...)
		return deps.Run("git", append(full, args...), opts)
	}
	for _, name := range strings.Split(git("remote").Stdout, "\n") {
		if !isRemoteName(name) {
			continue
		}
		got := git("remote", "get-url", name)
		if WithoutUser(strings.TrimSpace(got.Stdout)) != WithoutUser(remote) {
			continue
		}
		git("update-ref", "refs/remotes/"+name+"/"+branch, "refs/heads/"+branch)
		git("branch", "--set-upstream-to="+name+"/"+branch, branch)
		return
	}
}

func isRemoteName(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// Credential is the saved https secret of username on host, from `git credential fill`. It fails with a fixed sentence.
func Credential(deps PushDeps, params protocol.GitCredentialParams) (string, error) {
	if !protocol.IsHostName(params.Host) {
		return "", errors.New("That is not a git host name.")
	}
	if strings.ContainsAny(params.Username, "\r\n\x00") {
		return "", errors.New("That is not an account name.")
	}
	result := deps.Run("git", []string{"credential", "fill"}, run.Options{
		Env:     baseEnv(deps),
		Timeout: credentialTimeout,
		Input:   "protocol=https\nhost=" + params.Host + "\nusername=" + params.Username + "\n\n",
	})
	secret := ""
	for _, line := range strings.Split(result.Stdout, "\n") {
		if value, ok := strings.CutPrefix(strings.TrimRight(line, "\r"), "password="); ok && value != "" {
			secret = strings.TrimSpace(value)
			break
		}
	}
	if result.Code != 0 || secret == "" {
		return "", fmt.Errorf("This computer has no saved login for %s on %s.", params.Username, params.Host)
	}
	return secret, nil
}

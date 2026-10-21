package clitools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"go.yaml.in/yaml/v3"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

// Signs a workspace in to a git host with the host's own CLI in the browser: `gh auth login --web`
// or `glab auth login --web`. Their OAuth apps are already registered, so majhi needs none.
//
// Isolation, so the owner's own CLI login is never read or changed:
//   - The CLI runs with a config folder of the workspace's own, `<MAJHI_HOME>/git/<org>/<cli>`
//     (mode 700), and HOME and the XDG folders pointed inside it.
//   - `--insecure-storage` keeps the token in that folder's file, never a system keyring.
//   - The environment is built here: no GH_TOKEN, GITLAB_TOKEN or anything else of the helper's.
//   - The token is read from that folder's file only (never `gh auth token`, which falls back to the
//     keyring), and the folder is removed when the job ends, whatever happened.

// GitHubScopes are what `gh` asks for. They mirror GITHUB_TOKEN_SCOPES in packages/shared.
var GitHubScopes = []string{"repo", "read:org", "workflow"}

// GitLoginTimeout: a sign-in never runs longer than this: GitHub's device codes last 15 minutes.
const GitLoginTimeout = 15 * time.Minute

var cliLabel = map[string]string{"gh": "GitHub", "glab": "GitLab"}

// LoginDeps are what the git CLI sign-ins need.
type LoginDeps struct {
	MajhiHome string
	// Path is the PATH the CLI is found on and runs with.
	Path string
	// Find is the absolute path of `gh` or `glab`, or "" when not installed.
	Find func(cli string) string
	// Env is passed on when set, so the CLI has a temp folder and a locale. Nothing else of the helper's.
	Env     map[string]string
	Timeout time.Duration
}

// LoginDir is the folder a workspace's CLI sign-in runs in. org is a workspace id, so it never leaves the folder.
func LoginDir(majhiHome, org, cli string) string { return filepath.Join(majhiHome, "git", org, cli) }

// LoginArgs are the CLI's arguments. No token, ever: the CLI makes it and keeps it in its own file.
func LoginArgs(cli, host string) []string {
	common := []string{"auth", "login", "--hostname", host, "--web", "--git-protocol", "https"}
	if cli == "gh" {
		return append(common, "--skip-ssh-key", "--insecure-storage", "--scopes", strings.Join(GitHubScopes, ","))
	}
	return append(common, "--insecure-storage")
}

type ghHost struct {
	OAuthToken string `yaml:"oauth_token"`
	User       string `yaml:"user"`
	Users      map[string]*struct {
		OAuthToken string `yaml:"oauth_token"`
	} `yaml:"users"`
}

type glabHost struct {
	Token        string `yaml:"token"`
	RefreshToken string `yaml:"oauth2_refresh_token"`
	ExpiryDate   string `yaml:"oauth2_expiry_date"`
}

// expiryLayouts are the shapes glab's expiry date may take.
var expiryLayouts = []string{
	time.RFC3339Nano, time.RFC3339, time.RFC822Z, time.RFC822, time.RFC1123Z, time.RFC1123,
	"2006-01-02 15:04:05.999999999 -0700 MST", "2006-01-02 15:04:05 -0700", "2006-01-02 15:04:05",
}

func parseExpiry(text string) (time.Time, bool) {
	for _, layout := range expiryLayouts {
		if t, err := time.Parse(layout, strings.TrimSpace(text)); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// ReadLoginToken is the token a finished login left in its config folder. It fails with a safe sentence when there is none.
func ReadLoginToken(cli, configDir, host string) (protocol.GitCliLoginResult, error) {
	missing := fmt.Errorf("%s finished, but left no token for %s. Start the sign-in again.", cli, host)
	name := "config.yml"
	if cli == "gh" {
		name = "hosts.yml"
	}
	data, err := os.ReadFile(filepath.Join(configDir, name))
	if err != nil {
		return protocol.GitCliLoginResult{}, missing
	}
	if cli == "gh" {
		var hosts map[string]*ghHost
		if yaml.Unmarshal(data, &hosts) != nil {
			return protocol.GitCliLoginResult{}, missing
		}
		entry := hosts[host]
		if entry == nil {
			return protocol.GitCliLoginResult{}, missing
		}
		token := entry.OAuthToken
		if token == "" && entry.User != "" {
			if u := entry.Users[entry.User]; u != nil {
				token = u.OAuthToken
			}
		}
		if token == "" {
			return protocol.GitCliLoginResult{}, missing
		}
		return protocol.GitCliLoginResult{State: "done", Token: token}, nil
	}
	var config struct {
		Hosts map[string]*glabHost `yaml:"hosts"`
	}
	if yaml.Unmarshal(data, &config) != nil {
		return protocol.GitCliLoginResult{}, missing
	}
	entry := config.Hosts[host]
	if entry == nil || entry.Token == "" {
		return protocol.GitCliLoginResult{}, missing
	}
	result := protocol.GitCliLoginResult{State: "done", Token: entry.Token, RefreshToken: entry.RefreshToken}
	if expiry, ok := parseExpiry(entry.ExpiryDate); ok {
		result.ExpiresAt = expiry.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return result, nil
}

// gitFailure is a safe sentence for a CLI that ended without signing in. Never the CLI's own words.
func gitFailure(cli, output string) error {
	host := cliLabel[cli]
	lower := strings.ToLower(output)
	if containsAny(lower, "access_denied", "access denied", "denied", "refused") {
		return fmt.Errorf("The sign-in was refused on %s. Nothing was saved.", host)
	}
	if containsAny(lower, "expired", "timeout", "time out", "timed out", "timedout") {
		return fmt.Errorf("The %s sign-in ran out of time. Nothing was saved. Start it again.", host)
	}
	if cli == "glab" && containsAny(lower, "client_id", "address already in use", "7171") {
		return errors.New("glab could not start its sign-in on this computer. Paste a personal access token instead.")
	}
	return fmt.Errorf("%s did not finish the sign-in. Nothing was saved. Start it again.", cli)
}

// Logins runs CLI sign-ins, one per workspace and CLI at a time, and stops them on request. A new
// sign-in for the same workspace and CLI stops the old one first.
type Logins struct {
	deps    LoginDeps
	mu      sync.Mutex
	running map[string]*running
}

// NewLogins builds it.
func NewLogins(deps LoginDeps) *Logins { return &Logins{deps: deps, running: map[string]*running{}} }

// Cancel stops the sign-in's CLI. False when none runs.
func (l *Logins) Cancel(signIn string) bool {
	l.mu.Lock()
	r := l.running[signIn]
	l.mu.Unlock()
	if r == nil {
		return false
	}
	r.cancel()
	return true
}

// Login signs in. It answers `missing` when the CLI is not installed.
func (l *Logins) Login(params protocol.GitCliLoginParams, progress func(protocol.LoginProgress)) (protocol.GitCliLoginResult, error) {
	file := l.deps.Find(params.CLI)
	if file == "" {
		return protocol.GitCliLoginResult{State: "missing"}, nil
	}
	key := params.Org + "/" + params.CLI
	l.mu.Lock()
	var same []string
	for id, r := range l.running {
		if r.key == key {
			same = append(same, id)
		}
	}
	l.mu.Unlock()
	for _, id := range same {
		l.Cancel(id)
	}

	dir := LoginDir(l.deps.MajhiHome, params.Org, params.CLI)
	configDir := filepath.Join(dir, "config")
	home := filepath.Join(dir, "home")
	if err := os.RemoveAll(dir); err != nil {
		return protocol.GitCliLoginResult{}, err
	}
	for _, folder := range []string{filepath.Join(l.deps.MajhiHome, "git"), filepath.Join(l.deps.MajhiHome, "git", params.Org)} {
		if err := mkdir700(folder); err != nil {
			return protocol.GitCliLoginResult{}, err
		}
	}
	for _, folder := range []string{configDir, home} {
		if err := os.MkdirAll(folder, 0o700); err != nil {
			return protocol.GitCliLoginResult{}, err
		}
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return protocol.GitCliLoginResult{}, err
	}
	browser := filepath.Join(dir, "open-url")
	if err := os.WriteFile(browser, []byte(browserScript), 0o700); err != nil {
		return protocol.GitCliLoginResult{}, err
	}
	defer os.RemoveAll(dir)
	return l.run(file, params, configDir, home, browser, progress)
}

func (l *Logins) run(file string, params protocol.GitCliLoginParams, configDir, home, browser string, progress func(protocol.LoginProgress)) (protocol.GitCliLoginResult, error) {
	env := map[string]string{
		"PATH": l.deps.Path, "HOME": home,
		"XDG_CONFIG_HOME": filepath.Join(home, ".config"),
		"XDG_STATE_HOME":  filepath.Join(home, ".local", "state"),
		"XDG_DATA_HOME":   filepath.Join(home, ".local", "share"),
		"XDG_CACHE_HOME":  filepath.Join(home, ".cache"),
		"BROWSER":         browser, "GLAB_BROWSER": browser,
		"NO_COLOR": "1", "GH_NO_UPDATE_NOTIFIER": "1", "GLAB_CHECK_UPDATE": "false",
	}
	if params.CLI == "gh" {
		env["GH_CONFIG_DIR"] = configDir
	} else {
		env["GLAB_CONFIG_DIR"] = configDir
	}
	for _, name := range []string{"TMPDIR", "LANG", "LC_ALL"} {
		if v := l.deps.Env[name]; v != "" {
			env[name] = v
		}
	}
	var mu sync.Mutex
	output := ""
	told := false
	take := func(chunk []byte) {
		mu.Lock()
		defer mu.Unlock()
		if len(output) < maxOutput {
			output += string(chunk)
		}
		if told {
			return
		}
		page, code := ParseLoginOutput(output)
		// gh prints its code first; wait for both so the owner sees them together.
		if page != "" && (params.CLI == "glab" || code != "") {
			told = true
			progress(protocol.LoginProgress{URL: page, Code: code})
		}
	}
	proc := run.Spawn(run.SpawnOptions{
		File: file, Args: LoginArgs(params.CLI, params.Host), Env: env, Cwd: home,
		OnStdout: take, OnStderr: take,
	})
	r := &running{proc: proc, key: params.Org + "/" + params.CLI}
	l.mu.Lock()
	l.running[params.SignIn] = r
	l.mu.Unlock()
	timeout := l.deps.Timeout
	if timeout <= 0 {
		timeout = GitLoginTimeout
	}
	timedOut := false
	var code int
	select {
	case <-proc.Done():
		code = proc.Wait()
	case <-time.After(timeout):
		timedOut = true
		proc.TerminateThenKill(killGrace)
		code = proc.Wait()
	}
	l.mu.Lock()
	if l.running[params.SignIn] == r {
		delete(l.running, params.SignIn)
	}
	l.mu.Unlock()
	mu.Lock()
	text := output
	mu.Unlock()
	switch {
	case r.wasCancelled():
		return protocol.GitCliLoginResult{State: "cancelled"}, nil
	case timedOut:
		return protocol.GitCliLoginResult{}, fmt.Errorf("The %s sign-in ran out of time. Nothing was saved.", cliLabel[params.CLI])
	case code != 0:
		return protocol.GitCliLoginResult{}, gitFailure(params.CLI, text)
	}
	return ReadLoginToken(params.CLI, configDir, params.Host)
}

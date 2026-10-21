package clitools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

// Tool is a command-line tool a workspace signs in to with the tool's own login (SPEC 5.14).
// Each check command was run with an empty profile to see its exit code (vercel 1, aws 253, doctl 1,
// gh 1 or 4 when signed out); the sign-in commands come from each tool's documentation. The table
// mirrors packages/shared/src/cli-tools.ts, and the contract test compares the two.
type Tool struct {
	ID     string
	Name   string
	Binary string
	Login  []string
	// Check is a read-only command that makes a real call with the sign-in. Its exit code decides:
	// 0 means the sign-in works, 127 means the tool is missing, anything else means it is not signed in.
	Check []string
	// Whoami prints who is signed in, for the account label. Never decides anything.
	Whoami []string
	// IdentityFromCheck: the check's output names the account (`vercel whoami`).
	IdentityFromCheck bool
	// Logout ends the sign-in at the service where the tool can.
	Logout []string
	// Enter: the tool waits for Enter before it opens the browser.
	Enter bool
	// Vars point the tool at the profile folder, for the login and for runs.
	Vars func(profile string) map[string]string
}

func xdg(profile string) map[string]string {
	return map[string]string{
		"XDG_CONFIG_HOME": profile + "/xdg/config",
		"XDG_DATA_HOME":   profile + "/xdg/data",
		"XDG_STATE_HOME":  profile + "/xdg/state",
		"XDG_CACHE_HOME":  profile + "/xdg/cache",
	}
}

// Tools are the tools majhi signs in to.
var Tools = map[string]Tool{
	"vercel": {
		ID: "vercel", Name: "Vercel CLI", Binary: "vercel",
		Login: []string{"login"}, Check: []string{"whoami"}, IdentityFromCheck: true, Logout: []string{"logout"},
		Vars: func(p string) map[string]string { return map[string]string{"XDG_DATA_HOME": xdg(p)["XDG_DATA_HOME"]} },
	},
	"stripe": {
		ID: "stripe", Name: "Stripe CLI", Binary: "stripe",
		Login: []string{"login"}, Check: []string{"balance", "retrieve"}, Logout: []string{"logout", "--all"}, Enter: true,
		Vars: func(p string) map[string]string {
			return map[string]string{"XDG_CONFIG_HOME": xdg(p)["XDG_CONFIG_HOME"]}
		},
	},
	"aws": {
		ID: "aws", Name: "AWS", Binary: "aws",
		Login: []string{"login"}, Check: []string{"sts", "get-caller-identity", "--output", "text"}, Logout: []string{"logout"},
		Vars: func(p string) map[string]string {
			return map[string]string{"AWS_CONFIG_FILE": p + "/aws/config", "AWS_SHARED_CREDENTIALS_FILE": p + "/aws/credentials"}
		},
	},
	"gcloud": {
		ID: "gcloud", Name: "Google Cloud", Binary: "gcloud",
		Login: []string{"auth", "login"},
		// `auth list` exits 0 with nothing signed in, so the check lists one project instead.
		Check:  []string{"projects", "list", "--limit=1", "--format=value(projectId)"},
		Whoami: []string{"auth", "list", "--filter=status:ACTIVE", "--format=value(account)"},
		Logout: []string{"auth", "revoke", "--all"},
		Vars:   func(p string) map[string]string { return map[string]string{"CLOUDSDK_CONFIG": p + "/gcloud"} },
	},
	"az": {
		ID: "az", Name: "Azure", Binary: "az",
		Login: []string{"login", "--use-device-code"},
		// Asks Azure for a token, which makes a real call, and prints only when it ends.
		Check:  []string{"account", "get-access-token", "--query", "expiresOn", "--output", "tsv"},
		Whoami: []string{"account", "show", "--query", "user.name", "--output", "tsv"},
		Logout: []string{"logout"},
		Vars:   func(p string) map[string]string { return map[string]string{"AZURE_CONFIG_DIR": p + "/azure"} },
	},
}

// ProfileDir is the folder name of a connection's CLI sign-in.
const ProfileDir = "profile"

// LoginEnv is what a login runs with: the tool's variables, plus a HOME and the XDG folders inside
// the profile, so nothing is read from or written to the owner's own folders.
func LoginEnv(t Tool, profile string) map[string]string {
	env := map[string]string{"HOME": profile + "/home"}
	for k, v := range xdg(profile) {
		env[k] = v
	}
	for k, v := range t.Vars(profile) {
		env[k] = v
	}
	return env
}

// ProfileFolders are the folders a login needs to exist, inside the profile.
func ProfileFolders(profile string) []string {
	return []string{
		profile + "/home", profile + "/xdg/config", profile + "/xdg/data", profile + "/xdg/state",
		profile + "/xdg/cache", profile + "/aws", profile + "/gcloud", profile + "/azure",
	}
}

const (
	// ToolTimeout is how long a sign-in may run.
	ToolTimeout  = 15 * time.Minute
	checkTimeout = 30 * time.Second
	maxOutput    = 64 * 1024
	// killGrace is how long a tool gets to end after it is asked to, before it is killed.
	killGrace = 5 * time.Second
)

// ToolDeps are what the CLI tool sign-ins need.
type ToolDeps struct {
	MajhiHome string
	// Path is the PATH the tool is found on and runs with.
	Path string
	Find func(binary string) string
	// Env is the helper's environment: only TMPDIR, LANG and LC_ALL are passed on from here.
	Env          map[string]string
	Timeout      time.Duration
	CheckTimeout time.Duration
	// Tools replaces the table, for tests.
	Tools map[string]Tool
}

type running struct {
	proc      *run.Proc
	mu        sync.Mutex
	cancelled bool
	key       string
}

func (r *running) cancel() {
	r.mu.Lock()
	r.cancelled = true
	r.mu.Unlock()
	r.proc.TerminateThenKill(killGrace)
}

func (r *running) wasCancelled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cancelled
}

// ToolLogins signs workspaces in to tools, one sign-in per connection at a time.
type ToolLogins struct {
	deps    ToolDeps
	mu      sync.Mutex
	running map[string]*running
}

// NewToolLogins builds it.
func NewToolLogins(deps ToolDeps) *ToolLogins {
	return &ToolLogins{deps: deps, running: map[string]*running{}}
}

func (t *ToolLogins) tool(id string) Tool {
	if def, ok := t.deps.Tools[id]; ok {
		return def
	}
	return Tools[id]
}

// ConnectionFolder is the connection's folder. connection is an id, so it never leaves the folder.
func ConnectionFolder(majhiHome, connection string) string {
	return filepath.Join(majhiHome, "connections", connection)
}

func profileFolder(majhiHome, connection string) string {
	return filepath.Join(ConnectionFolder(majhiHome, connection), ProfileDir)
}

// env is the environment of every command here: nothing of the helper's, only what the profile needs.
func (t *ToolLogins) env(def Tool, profile string, extra map[string]string) map[string]string {
	env := map[string]string{"PATH": t.deps.Path, "NO_COLOR": "1", "CI": ""}
	for k, v := range LoginEnv(def, profile) {
		env[k] = v
	}
	for k, v := range extra {
		env[k] = v
	}
	for _, name := range []string{"TMPDIR", "LANG", "LC_ALL"} {
		if v := t.deps.Env[name]; v != "" {
			env[name] = v
		}
	}
	return env
}

// Cancel stops the sign-in's tool. False when none runs.
func (t *ToolLogins) Cancel(signIn string) bool {
	t.mu.Lock()
	r := t.running[signIn]
	t.mu.Unlock()
	if r == nil {
		return false
	}
	r.cancel()
	return true
}

func mkdir700(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}

// Login signs a workspace in to a tool with the tool's own login. The login runs in the profile
// after the old one was moved aside. It is kept only when the tool's check command works (and, with
// `expected`, names the same account). Failure, cancel and timeout remove the new folder and put the
// old one back.
func (t *ToolLogins) Login(params protocol.CliLoginParams, progress func(protocol.LoginProgress)) (protocol.CliLoginResult, error) {
	def := t.tool(params.Tool)
	file := t.deps.Find(def.Binary)
	if file == "" {
		return protocol.CliLoginResult{State: "missing"}, nil
	}
	t.mu.Lock()
	var same []string
	for id, r := range t.running {
		if r.key == params.Connection {
			same = append(same, id)
		}
	}
	t.mu.Unlock()
	for _, id := range same {
		t.Cancel(id)
	}

	folder := ConnectionFolder(t.deps.MajhiHome, params.Connection)
	profile := profileFolder(t.deps.MajhiHome, params.Connection)
	for _, dir := range []string{filepath.Join(t.deps.MajhiHome, "connections"), folder} {
		if err := mkdir700(dir); err != nil {
			return protocol.CliLoginResult{}, err
		}
	}
	// The old sign-in waits aside until the new one is proven.
	aside := fmt.Sprintf("%s-old-%d-%d", profile, os.Getpid(), time.Now().UnixMilli())
	hadOld := os.Rename(profile, aside) == nil
	keep := false
	defer func() {
		if keep {
			_ = os.RemoveAll(aside)
			return
		}
		_ = os.RemoveAll(profile)
		if hadOld {
			_ = os.Rename(aside, profile)
		}
	}()
	if err := mkdir700(profile); err != nil {
		return protocol.CliLoginResult{}, err
	}
	for _, dir := range ProfileFolders(profile) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return protocol.CliLoginResult{}, err
		}
	}
	browser := filepath.Join(profile, "open-url")
	if err := os.WriteFile(browser, []byte(browserScript), 0o700); err != nil {
		return protocol.CliLoginResult{}, err
	}
	ended, err := t.runLogin(file, def, params, profile, browser, progress)
	if err != nil {
		return protocol.CliLoginResult{}, err
	}
	if ended == "cancelled" {
		return protocol.CliLoginResult{State: "cancelled"}, nil
	}
	_ = os.Remove(browser)
	checked := t.runCheck(file, def, profile)
	if !checked.OK {
		return protocol.CliLoginResult{}, fmt.Errorf("%s finished, but it does not show a sign-in. Nothing was saved.", def.Name)
	}
	if params.Expected != "" && checked.Identity != "" && !strings.EqualFold(checked.Identity, params.Expected) {
		return protocol.CliLoginResult{State: "other-account", Identity: checked.Identity}, nil
	}
	keep = true
	return protocol.CliLoginResult{State: "done", Identity: checked.Identity}, nil
}

const browserScript = "#!/bin/sh\nprintf '" + urlMarker + " %s\\n' \"$1\" >&2\n"

func (t *ToolLogins) runLogin(file string, def Tool, params protocol.CliLoginParams, profile, browser string, progress func(protocol.LoginProgress)) (string, error) {
	var mu sync.Mutex
	output := ""
	var toldURL, toldCode string
	pressed := false
	var proc *run.Proc
	take := func(chunk []byte) {
		mu.Lock()
		defer mu.Unlock()
		if len(output) < maxOutput {
			output += string(chunk)
		}
		page, code := ParseToolOutput(output)
		if page != "" && !pressed && def.Enter {
			pressed = true
			proc.WriteStdin("\n")
		}
		if page == "" || (page == toldURL && code == toldCode) {
			return
		}
		toldURL, toldCode = page, code
		progress(protocol.LoginProgress{URL: page, Code: code})
	}
	// The process must exist before `take` can write to it; output only arrives after the start.
	started := make(chan struct{})
	proc = run.Spawn(run.SpawnOptions{
		File: file, Args: def.Login, Env: t.env(def, profile, map[string]string{"BROWSER": browser}),
		Cwd: filepath.Join(profile, "home"), Stdin: def.Enter,
		OnStdout: func(b []byte) { <-started; take(b) },
		OnStderr: func(b []byte) { <-started; take(b) },
	})
	close(started)
	r := &running{proc: proc, key: params.Connection}
	t.mu.Lock()
	t.running[params.SignIn] = r
	t.mu.Unlock()
	timeout := t.deps.Timeout
	if timeout <= 0 {
		timeout = ToolTimeout
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
	t.mu.Lock()
	if t.running[params.SignIn] == r {
		delete(t.running, params.SignIn)
	}
	t.mu.Unlock()
	mu.Lock()
	text := output
	mu.Unlock()
	switch {
	case r.wasCancelled():
		return "cancelled", nil
	case timedOut:
		return "", fmt.Errorf("The %s sign-in ran out of time. Nothing was saved.", def.Name)
	case code != 0:
		return "", toolFailure(def, text)
	}
	return "done", nil
}

// toolFailure is a safe sentence for a tool that ended without signing in. Never the tool's own words.
func toolFailure(def Tool, output string) error {
	lower := strings.ToLower(output)
	if containsAny(lower, "access_denied", "access denied", "denied", "refused", "rejected") {
		return fmt.Errorf("The sign-in was refused on %s. Nothing was saved.", def.Name)
	}
	if containsAny(lower, "expired", "timeout", "time out", "timed out", "timedout") {
		return fmt.Errorf("The %s sign-in ran out of time. Nothing was saved. Start it again.", def.Name)
	}
	return fmt.Errorf("%s did not finish the sign-in. Nothing was saved. Start it again.", def.Name)
}

func containsAny(lower string, phrases ...string) bool {
	for _, p := range phrases {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

type captured struct {
	code     int
	stdout   string
	timedOut bool
}

// capture runs the tool to the end with its stderr dropped. The exit code decides, never the words the tool printed.
func capture(file string, args []string, env map[string]string, cwd string, timeout time.Duration) captured {
	var mu sync.Mutex
	stdout := ""
	proc := run.Spawn(run.SpawnOptions{
		File: file, Args: args, Env: env, Cwd: cwd,
		OnStdout: func(b []byte) {
			mu.Lock()
			if len(stdout) < maxOutput {
				stdout += string(b)
			}
			mu.Unlock()
		},
		OnStderr: func([]byte) {},
	})
	select {
	case <-proc.Done():
		mu.Lock()
		defer mu.Unlock()
		return captured{code: proc.Wait(), stdout: stdout}
	case <-time.After(timeout):
		proc.TerminateThenKill(killGrace)
		proc.Wait()
		return captured{code: run.NoCode, timedOut: true}
	}
}

func (t *ToolLogins) runCheck(file string, def Tool, profile string) protocol.CliCheckResult {
	env := t.env(def, profile, nil)
	home := filepath.Join(profile, "home")
	timeout := t.deps.CheckTimeout
	if timeout <= 0 {
		timeout = checkTimeout
	}
	out := capture(file, def.Check, env, home, timeout)
	// The exit code decides, never the words the tool printed.
	switch {
	case out.timedOut:
		return protocol.CliCheckResult{OK: false, Detail: def.Name + " did not answer in time.", Failure: protocol.FailureTimeout}
	case out.code == run.NoCode || out.code == 127:
		return protocol.CliCheckResult{OK: false, Detail: def.Binary + " did not run.", Failure: protocol.FailureToolMissing}
	case out.code != 0:
		return protocol.CliCheckResult{OK: false, Detail: def.Name + " is not signed in.", Failure: protocol.FailureNotSignedIn}
	}
	identity := ""
	if def.Whoami != nil {
		who := capture(file, def.Whoami, env, home, timeout)
		if who.code == 0 {
			identity = ParseIdentity(who.stdout)
		}
	} else if def.IdentityFromCheck {
		identity = ParseIdentity(out.stdout)
	}
	return protocol.CliCheckResult{OK: true, Identity: identity, Detail: "Signed in."}
}

// Check runs the tool's check command in the connection's profile.
func (t *ToolLogins) Check(params protocol.CliToolParams) (protocol.CliCheckResult, error) {
	def := t.tool(params.Tool)
	file := t.deps.Find(def.Binary)
	if file == "" {
		return protocol.CliCheckResult{OK: false, Detail: def.Binary + " is not installed on this computer."}, nil
	}
	return t.runCheck(file, def, profileFolder(t.deps.MajhiHome, params.Connection)), nil
}

// Logout signs out at the service where the tool can, then removes the profile whatever happened.
func (t *ToolLogins) Logout(params protocol.CliToolParams) (map[string]bool, error) {
	def := t.tool(params.Tool)
	profile := profileFolder(t.deps.MajhiHome, params.Connection)
	revoked := false
	if file := t.deps.Find(def.Binary); file != "" {
		timeout := t.deps.CheckTimeout
		if timeout <= 0 {
			timeout = checkTimeout
		}
		out := capture(file, def.Logout, t.env(def, profile, nil), filepath.Join(profile, "home"), timeout)
		revoked = out.code == 0
	}
	if err := os.RemoveAll(profile); err != nil {
		return nil, err
	}
	return map[string]bool{"revoked": revoked}, nil
}
